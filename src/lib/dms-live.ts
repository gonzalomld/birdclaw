import { Effect } from "effect";
import type { Database } from "./sqlite";
import {
	type BirdDmConversation,
	type BirdDmEvent,
	type BirdDmUser,
	getAuthenticatedBirdAccountEffect,
	listDirectMessagesViaBirdEffect,
} from "./bird";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import type { XurlMentionUser } from "./types";
import {
	buildExternalProfileId,
	randomAvatarHue,
	upsertProfileFromXUser,
} from "./x-profile";

export const DEFAULT_DMS_CACHE_TTL_MS = 2 * 60_000;
const PREVIEW_MESSAGE_ID_PREFIX = "preview:";

export interface SyncDirectMessagesViaCachedBirdOptions {
	account?: string;
	limit?: number;
	inbox?: "all" | "accepted" | "requests";
	maxPages?: number;
	allPages?: boolean;
	pageDelayMs?: number;
	refresh?: boolean;
	cacheTtlMs?: number;
}

function parseCacheTtlMs(value?: number) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return DEFAULT_DMS_CACHE_TTL_MS;
	}
	return Math.floor(value);
}

function assertBirdLimit(limit: number) {
	if (!Number.isFinite(limit) || limit < 1) {
		throw new Error("bird DM mode requires --limit of at least 1");
	}
}

function normalizeExternalUserId(value: string | null | undefined) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function makePreviewMessageId(conversationId: string): string {
	return `${PREVIEW_MESSAGE_ID_PREFIX}${conversationId}`;
}

function resolveAccount(db: Database, accountId?: string) {
	const row = accountId
		? (db
				.prepare(
					"select id, handle, external_user_id from accounts where id = ?",
				)
				.get(accountId) as
				| { id: string; handle: string; external_user_id: string | null }
				| undefined)
		: (db
				.prepare(
					`
          select id, handle, external_user_id
          from accounts
          order by is_default desc, created_at asc
          limit 1
          `,
				)
				.get() as
				| { id: string; handle: string; external_user_id: string | null }
				| undefined);

	if (!row) {
		throw new Error(`Unknown account: ${accountId ?? "default"}`);
	}

	return {
		accountId: row.id,
		username: row.handle.replace(/^@/, ""),
		externalUserId: normalizeExternalUserId(row.external_user_id),
	};
}

function toIsoTimestamp(value?: string) {
	if (!value) {
		return new Date().toISOString();
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function toXUser(user: BirdDmUser): XurlMentionUser {
	return {
		id: user.id,
		username: user.username ?? `user_${user.id}`,
		name: user.name ?? user.username ?? `user_${user.id}`,
		profile_image_url: user.profileImageUrl,
		public_metrics: { followers_count: 0 },
	};
}

function collectUsers(
	payload: {
		conversations: BirdDmConversation[];
		events: BirdDmEvent[];
	},
	accountExternalUserId?: string,
) {
	const users = new Map<string, BirdDmUser>();
	const add = (user?: BirdDmUser) => {
		if (!user?.id) return;
		if (
			accountExternalUserId &&
			user.id === accountExternalUserId &&
			!user.username &&
			!user.name
		) {
			return;
		}
		users.set(user.id, { ...users.get(user.id), ...user });
	};
	const addId = (id?: string) => {
		if (!id || users.has(id) || id === accountExternalUserId) return;
		users.set(id, { id });
	};

	for (const conversation of payload.conversations) {
		for (const participant of conversation.participants) {
			add(participant);
		}
	}
	for (const event of payload.events) {
		add(event.sender);
		add(event.recipient);
		addId(event.senderId);
		addId(event.recipientId);
	}
	return users;
}

function getLocalExternalUserId(
	users: Map<string, BirdDmUser>,
	accountUsername: string,
	accountExternalUserId?: string,
) {
	if (accountExternalUserId) {
		return accountExternalUserId;
	}
	const normalizedAccountUsername = accountUsername.toLowerCase();
	for (const user of users.values()) {
		if (user.username?.toLowerCase() === normalizedAccountUsername) {
			return user.id;
		}
	}
	return undefined;
}

function getLatestEvent(events: BirdDmEvent[]) {
	return [...events].sort(
		(left, right) =>
			new Date(right.createdAt ?? 0).getTime() -
			new Date(left.createdAt ?? 0).getTime(),
	)[0];
}

function assertAuthenticatedBirdAccountMatches({
	accountId,
	username,
	externalUserId,
	liveUsername,
	liveExternalUserId,
}: {
	accountId: string;
	username: string;
	externalUserId?: string;
	liveUsername: string;
	liveExternalUserId?: string;
}) {
	if (
		externalUserId &&
		liveExternalUserId &&
		liveExternalUserId === externalUserId
	) {
		return;
	}
	if (externalUserId && liveExternalUserId) {
		throw new Error(
			`bird is authenticated as user ${liveExternalUserId}; refusing to sync into ${accountId} (${externalUserId})`,
		);
	}
	if (liveUsername.toLowerCase() !== username.toLowerCase()) {
		throw new Error(
			`bird is authenticated as @${liveUsername}; refusing to sync into ${accountId} (@${username})`,
		);
	}
}

function persistAccountExternalUserId(
	db: Database,
	accountId: string,
	externalUserId: string,
) {
	db.prepare(
		`
    update accounts
    set external_user_id = ?
    where id = ?
      and (external_user_id is null or trim(external_user_id) = '')
    `,
	).run(externalUserId, accountId);
}

function conversationIdReferencesExternalUserId(
	conversationId: string,
	externalUserId: string,
) {
	return conversationId.split(/[^0-9]+/).includes(externalUserId);
}

function payloadReferencesExternalUserId(
	payload: {
		conversations: BirdDmConversation[];
		events: BirdDmEvent[];
	},
	externalUserId: string,
) {
	for (const conversation of payload.conversations) {
		if (
			conversationIdReferencesExternalUserId(conversation.id, externalUserId)
		) {
			return true;
		}
		if (conversation.participants.some((user) => user.id === externalUserId)) {
			return true;
		}
	}
	for (const event of payload.events) {
		if (
			event.senderId === externalUserId ||
			event.recipientId === externalUserId
		) {
			return true;
		}
		if (
			event.sender?.id === externalUserId ||
			event.recipient?.id === externalUserId
		) {
			return true;
		}
		if (
			event.conversationId &&
			conversationIdReferencesExternalUserId(
				event.conversationId,
				externalUserId,
			)
		) {
			return true;
		}
	}
	return false;
}

function ensureSparseLocalProfile(
	db: Database,
	externalUserId: string,
	accountUsername: string,
) {
	const profileId = buildExternalProfileId(externalUserId);
	const existing = db
		.prepare("select id from profiles where id = ? or handle = ? limit 1")
		.get(profileId, accountUsername) as { id: string } | undefined;
	if (existing) {
		return existing.id;
	}

	const createdAt = new Date().toISOString();
	db.prepare(
		`
    insert into profiles (
      id, handle, display_name, bio, followers_count, following_count,
      public_metrics_json, avatar_hue, entities_json, raw_json, created_at
    ) values (?, ?, ?, '', 0, 0, '{}', ?, '{}', '{}', ?)
    `,
	).run(
		profileId,
		accountUsername,
		accountUsername,
		randomAvatarHue(accountUsername),
		createdAt,
	);
	return profileId;
}

function mergeDirectMessagesIntoLocalStore(
	db: Database,
	accountId: string,
	accountUsername: string,
	accountExternalUserId: string | undefined,
	payload: {
		conversations: BirdDmConversation[];
		events: BirdDmEvent[];
	},
) {
	const users = collectUsers(payload, accountExternalUserId);
	const localExternalUserId = getLocalExternalUserId(
		users,
		accountUsername,
		accountExternalUserId,
	);
	if (
		accountExternalUserId &&
		(payload.conversations.length > 0 || payload.events.length > 0) &&
		!payloadReferencesExternalUserId(payload, accountExternalUserId)
	) {
		throw new Error(
			`bird DM payload does not include @${accountUsername}; refusing to sync into ${accountId}`,
		);
	}
	if (
		!localExternalUserId &&
		(payload.conversations.length > 0 || payload.events.length > 0)
	) {
		throw new Error(
			`bird DM payload does not include @${accountUsername}; refusing to sync into ${accountId}`,
		);
	}
	if (!localExternalUserId) {
		return;
	}
	const profilesByExternalId = new Map<string, string>();
	for (const user of users.values()) {
		const resolved = upsertProfileFromXUser(db, toXUser(user));
		profilesByExternalId.set(user.id, resolved.profile.id);
	}
	if (
		accountExternalUserId &&
		!profilesByExternalId.has(accountExternalUserId)
	) {
		profilesByExternalId.set(
			accountExternalUserId,
			ensureSparseLocalProfile(db, accountExternalUserId, accountUsername),
		);
	}

	const eventsByConversation = new Map<string, BirdDmEvent[]>();
	for (const event of payload.events) {
		if (!event.conversationId) continue;
		const events = eventsByConversation.get(event.conversationId) ?? [];
		events.push(event);
		eventsByConversation.set(event.conversationId, events);
	}

	const upsertConversation = db.prepare(`
    insert into dm_conversations (
      id, account_id, participant_profile_id, title, inbox_kind, last_message_at, unread_count, needs_reply
    ) values (?, ?, ?, ?, ?, ?, 0, ?)
    on conflict(id) do update set
      account_id = excluded.account_id,
      participant_profile_id = excluded.participant_profile_id,
      title = excluded.title,
      inbox_kind = excluded.inbox_kind,
      last_message_at = excluded.last_message_at,
      needs_reply = excluded.needs_reply
  `);
	const upsertMessage = db.prepare(`
    insert into dm_messages (
      id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
    ) values (?, ?, ?, ?, ?, ?, 0, 0)
    on conflict(id) do update set
      conversation_id = excluded.conversation_id,
      sender_profile_id = excluded.sender_profile_id,
      text = excluded.text,
      created_at = excluded.created_at,
      direction = excluded.direction,
      media_count = excluded.media_count
  `);
	const replaceFts = db.prepare("delete from dm_fts where message_id = ?");
	const insertFts = db.prepare(
		"insert into dm_fts (message_id, text) values (?, ?)",
	);
	const deleteMessage = db.prepare("delete from dm_messages where id = ?");

	db.transaction(() => {
		for (const conversation of payload.conversations) {
			const events = eventsByConversation.get(conversation.id) ?? [];
			if (events.length === 0 && !conversation.lastMessagePreview) {
				continue;
			}

			const participant =
				conversation.participants.find(
					(user) =>
						user.id !== localExternalUserId &&
						user.username?.toLowerCase() !== accountUsername.toLowerCase(),
				) ?? conversation.participants[0];
			if (!participant) {
				continue;
			}
			const participantProfileId = profilesByExternalId.get(participant.id);
			if (!participantProfileId) {
				continue;
			}

			const latest = getLatestEvent(events);
			const lastMessageAt = toIsoTimestamp(
				latest?.createdAt ?? conversation.lastMessageAt,
			);
			const inboxKind =
				conversation.inboxKind ??
				(conversation.isMessageRequest ? "request" : "accepted");
			const latestInbound = latest
				? latest.senderId !== localExternalUserId &&
					latest.sender?.username?.toLowerCase() !==
						accountUsername.toLowerCase()
				: inboxKind === "request";
			upsertConversation.run(
				conversation.id,
				accountId,
				participantProfileId,
				participant.username ?? participant.name ?? participant.id,
				inboxKind,
				lastMessageAt,
				latestInbound ? 1 : 0,
			);

			const previewMessageId = makePreviewMessageId(conversation.id);
			if (events.length === 0 && conversation.lastMessagePreview) {
				const previewSenderProfileId = latestInbound
					? participantProfileId
					: (profilesByExternalId.get(localExternalUserId) ??
						participantProfileId);
				upsertMessage.run(
					previewMessageId,
					conversation.id,
					previewSenderProfileId,
					conversation.lastMessagePreview,
					lastMessageAt,
					latestInbound ? "inbound" : "outbound",
				);
				replaceFts.run(previewMessageId);
				insertFts.run(previewMessageId, conversation.lastMessagePreview);
				continue;
			}

			replaceFts.run(previewMessageId);
			deleteMessage.run(previewMessageId);

			for (const event of events) {
				const senderId = event.senderId ?? event.sender?.id;
				if (!senderId) {
					continue;
				}
				const senderProfileId = profilesByExternalId.get(senderId);
				if (!senderProfileId) {
					continue;
				}
				const direction =
					senderId === localExternalUserId ||
					event.sender?.username?.toLowerCase() ===
						accountUsername.toLowerCase()
						? "outbound"
						: "inbound";
				upsertMessage.run(
					event.id,
					conversation.id,
					senderProfileId,
					event.text,
					toIsoTimestamp(event.createdAt),
					direction,
				);
				replaceFts.run(event.id);
				insertFts.run(event.id, event.text);
			}
		}
	})();
}

export function syncDirectMessagesViaCachedBirdEffect({
	account,
	limit = 20,
	inbox = "all",
	maxPages,
	allPages = false,
	pageDelayMs,
	refresh = false,
	cacheTtlMs,
}: SyncDirectMessagesViaCachedBirdOptions = {}): Effect.Effect<
	{
		ok: true;
		source: "bird" | "cache";
		accountId: string;
		conversations: number;
		messages: number;
	},
	unknown
> {
	return Effect.gen(function* () {
		assertBirdLimit(limit);
		const db = getNativeDb();
		const resolvedAccount = resolveAccount(db, account);
		const pageKey = allPages
			? "all-pages"
			: `max-pages:${String(maxPages ?? 0)}`;
		const cacheKey = `dms:bird:${resolvedAccount.accountId}:${String(limit)}:${inbox}:${pageKey}`;
		const ttlMs = parseCacheTtlMs(cacheTtlMs);
		const cached = readSyncCache<{
			conversations: BirdDmConversation[];
			events: BirdDmEvent[];
		}>(cacheKey, db);
		const cacheAgeMs = cached
			? Date.now() - new Date(cached.updatedAt).getTime()
			: Number.POSITIVE_INFINITY;

		const cacheHit = !refresh && cached && cacheAgeMs <= ttlMs;
		let accountExternalUserId = resolvedAccount.externalUserId;
		let payload: {
			conversations: BirdDmConversation[];
			events: BirdDmEvent[];
		};
		if (cacheHit) {
			payload = cached.value;
		} else {
			const authenticated = yield* getAuthenticatedBirdAccountEffect();
			assertAuthenticatedBirdAccountMatches({
				accountId: resolvedAccount.accountId,
				username: resolvedAccount.username,
				externalUserId: resolvedAccount.externalUserId,
				liveUsername: authenticated.username,
				liveExternalUserId: authenticated.id,
			});
			accountExternalUserId ??= authenticated.id;
			if (!resolvedAccount.externalUserId && accountExternalUserId) {
				persistAccountExternalUserId(
					db,
					resolvedAccount.accountId,
					accountExternalUserId,
				);
			}
			payload = yield* listDirectMessagesViaBirdEffect({
				maxResults: limit,
				...(inbox !== "all" ? { inbox } : {}),
				...(typeof maxPages === "number" ? { maxPages } : {}),
				...(allPages ? { allPages } : {}),
				...(typeof pageDelayMs === "number" ? { pageDelayMs } : {}),
			});
		}

		mergeDirectMessagesIntoLocalStore(
			db,
			resolvedAccount.accountId,
			resolvedAccount.username,
			accountExternalUserId,
			payload,
		);
		if (!cached || refresh || cacheAgeMs > ttlMs) {
			writeSyncCache(cacheKey, payload, db);
		}

		return {
			ok: true,
			source: cacheHit ? "cache" : "bird",
			accountId: resolvedAccount.accountId,
			conversations: payload.conversations.length,
			messages: payload.events.length,
		} as const;
	});
}

export function syncDirectMessagesViaCachedBird(
	options: SyncDirectMessagesViaCachedBirdOptions = {},
) {
	return runEffectPromise(syncDirectMessagesViaCachedBirdEffect(options));
}
