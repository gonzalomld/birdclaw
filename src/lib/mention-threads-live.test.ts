// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { listTimelineItems } from "./queries";

const mocks = vi.hoisted(() => ({
	listThreadViaBird: vi.fn(),
	searchRecentByConversationId: vi.fn(),
	getTweetById: vi.fn(),
}));

vi.mock("./bird", () => ({
	listThreadViaBird: mocks.listThreadViaBird,
}));

vi.mock("./xurl", () => ({
	searchRecentByConversationId: mocks.searchRecentByConversationId,
	getTweetById: mocks.getTweetById,
}));

const tempRoots: string[] = [];

function setupTempHome() {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-threads-"));
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	const db = getNativeDb();
	db.exec(
		"delete from tweet_account_edges; delete from tweets; delete from tweets_fts;",
	);
	db.prepare(
		`
    insert into tweets (
      id, account_id, author_profile_id, kind, text, created_at,
      is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
      entities_json, media_json, quoted_tweet_id
    ) values (?, 'acct_primary', 'profile_user_42', 'mention', ?, ?, 0, null, 0, 0, 0, 0, '{}', '[]', null)
    `,
	).run("mention_1", "mention text", "2026-05-04T07:00:00.000Z");
}

function insertMention(id: string, text: string, createdAt: string) {
	getNativeDb()
		.prepare(
			`
    insert into tweets (
      id, account_id, author_profile_id, kind, text, created_at,
      is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
      entities_json, media_json, quoted_tweet_id
    ) values (?, 'acct_primary', 'profile_user_42', 'mention', ?, ?, 0, null, 0, 0, 0, 0, '{}', '[]', null)
    `,
		)
		.run(id, text, createdAt);
}

function upsertMentionEdge(
	id: string,
	raw: Record<string, unknown>,
	seenAt = "2026-05-12T10:00:00.000Z",
	source = "xurl",
) {
	getNativeDb()
		.prepare(
			`
    insert into tweet_account_edges (
	      account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
	      source, raw_json, updated_at
	    ) values ('acct_primary', ?, 'mention', ?, ?, 1, ?, ?, ?)
	    on conflict(account_id, tweet_id, kind) do update set
	      raw_json = excluded.raw_json,
	      last_seen_at = excluded.last_seen_at,
	      updated_at = excluded.updated_at
	    `,
		)
		.run(id, seenAt, seenAt, source, JSON.stringify(raw), seenAt);
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	mocks.listThreadViaBird.mockReset();
	mocks.searchRecentByConversationId.mockReset();
	mocks.getTweetById.mockReset();
	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

describe("mention thread sync", () => {
	it("fetches recent mention threads with timeout and stores conversation context", async () => {
		setupTempHome();
		mocks.listThreadViaBird.mockResolvedValue({
			data: [
				{
					id: "root_1",
					author_id: "25401953",
					text: "root post",
					created_at: "2026-05-04T06:00:00.000Z",
					conversation_id: "root_1",
					public_metrics: { like_count: 10 },
				},
				{
					id: "mention_1",
					author_id: "42",
					text: "mention text",
					created_at: "2026-05-04T07:00:00.000Z",
					conversation_id: "root_1",
					referenced_tweets: [{ type: "replied_to", id: "root_1" }],
					public_metrics: { like_count: 2 },
				},
				{
					id: "side_reply_1",
					author_id: "43",
					text: "side reply",
					created_at: "2026-05-04T07:01:00.000Z",
					conversation_id: "root_1",
					referenced_tweets: [{ type: "replied_to", id: "root_1" }],
				},
			],
			includes: {
				users: [
					{ id: "25401953", username: "steipete", name: "Peter" },
					{ id: "42", username: "sam", name: "Sam" },
					{ id: "43", username: "alex", name: "Alex" },
				],
			},
			meta: { result_count: 3 },
		});
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			limit: 1,
			delayMs: 0,
			timeoutMs: 5000,
		});
		const db = getNativeDb();
		const sideReply = db
			.prepare("select kind, reply_to_id from tweets where id = ?")
			.get("side_reply_1");
		const home = listTimelineItems({ resource: "home", limit: 10 });
		const mentions = listTimelineItems({ resource: "mentions", limit: 10 });

		expect(result).toMatchObject({
			ok: true,
			mentions: 1,
			succeeded: 1,
			failed: 0,
			mergedTweets: 3,
			uniqueTweets: 3,
		});
		expect(mocks.listThreadViaBird).toHaveBeenCalledWith({
			tweetId: "mention_1",
			all: false,
			maxPages: undefined,
			timeoutMs: 5000,
		});
		expect(home.find((item) => item.id === "root_1")).toMatchObject({
			kind: "home",
			author: { handle: "steipete" },
		});
		expect(mentions.find((item) => item.id === "mention_1")).toMatchObject({
			kind: "mention",
			replyToTweet: expect.objectContaining({ id: "root_1" }),
		});
		expect(sideReply).toEqual({ kind: "thread", reply_to_id: "root_1" });
	});

	it("records failed thread fetches without failing the sync", async () => {
		setupTempHome();
		mocks.listThreadViaBird.mockRejectedValue(new Error("rate limited"));
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			limit: 1,
			delayMs: 0,
			timeoutMs: 1000,
		});

		expect(result).toMatchObject({
			ok: true,
			mentions: 1,
			succeeded: 0,
			failed: 1,
			failures: [{ tweetId: "mention_1", error: "rate limited" }],
		});
	});

	it("handles multiple mentions, delay, non-error failures, and stub authors", async () => {
		setupTempHome();
		insertMention("mention_2", "newer mention", "2026-05-04T08:00:00.000Z");
		mocks.listThreadViaBird
			.mockResolvedValueOnce({
				data: [
					{
						id: "mention_2",
						author_id: "42",
						text: "newer mention",
						created_at: "2026-05-04T08:00:00.000Z",
						entities: {
							urls: [
								{ media_key: "media_1" },
								{ media_key: false },
								"not an object",
							],
						},
					},
					{
						id: "unknown_reply",
						author_id: "77",
						text: "unknown author reply",
						created_at: "2026-05-04T08:01:00.000Z",
					},
				],
				meta: { result_count: 2 },
			})
			.mockRejectedValueOnce("temporary failure");
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			limit: 2,
			delayMs: 1,
			timeoutMs: 1200,
			all: true,
			maxPages: 3,
		});
		const row = getNativeDb()
			.prepare("select media_count, author_profile_id from tweets where id = ?")
			.get("unknown_reply");

		expect(result).toMatchObject({
			mentions: 2,
			succeeded: 1,
			failed: 1,
			mergedTweets: 2,
			uniqueTweets: 2,
			options: { delayMs: 1, timeoutMs: 1200, all: true, maxPages: 3 },
			failures: [{ tweetId: "mention_1", error: "temporary failure" }],
		});
		expect(mocks.listThreadViaBird).toHaveBeenNthCalledWith(1, {
			tweetId: "mention_2",
			all: true,
			maxPages: 3,
			timeoutMs: 1200,
		});
		expect(row).toMatchObject({
			media_count: 0,
			author_profile_id: "profile_user_77",
		});
	});

	it("fetches xurl conversation search results and writes thread context edges", async () => {
		setupTempHome();
		insertMention(
			"mention_recent",
			"recent mention",
			"2026-05-12T10:00:00.000Z",
		);
		upsertMentionEdge("mention_recent", {
			id: "mention_recent",
			author_id: "42",
			text: "recent mention",
			created_at: "2026-05-12T10:00:00.000Z",
			conversation_id: "root_recent",
		});
		const payload = {
			data: [
				{
					id: "root_recent",
					author_id: "25401953",
					text: "root post",
					created_at: "2026-05-12T09:58:00.000Z",
					conversation_id: "root_recent",
					public_metrics: { like_count: 4 },
				},
				{
					id: "mention_recent",
					author_id: "42",
					text: "recent mention",
					created_at: "2026-05-12T10:00:00.000Z",
					conversation_id: "root_recent",
					referenced_tweets: [{ type: "replied_to", id: "root_recent" }],
					in_reply_to_user_id: "25401953",
				},
			],
			includes: {
				users: [
					{ id: "25401953", username: "steipete", name: "Peter" },
					{ id: "42", username: "sam", name: "Sam" },
				],
			},
			meta: { result_count: 2 },
		};
		mocks.searchRecentByConversationId
			.mockResolvedValueOnce(payload)
			.mockResolvedValueOnce(payload);
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			mode: "xurl",
			limit: 1,
			delayMs: 0,
		});
		const db = getNativeDb();
		const edges = db
			.prepare(
				"select tweet_id, kind, source from tweet_account_edges where kind = 'thread_context' order by tweet_id",
			)
			.all();
		const root = db
			.prepare("select kind from tweets where id = ?")
			.get("root_recent");

		expect(result).toMatchObject({
			ok: true,
			source: "xurl",
			mentions: 1,
			succeeded: 1,
			failed: 0,
			mergedTweets: 2,
			uniqueTweets: 2,
			generalReadTweets: 2,
			results: [
				expect.objectContaining({
					tweetId: "mention_recent",
					conversationId: "root_recent",
					strategy: "conversation_search",
					count: 2,
					pages: 1,
				}),
			],
		});
		expect(mocks.searchRecentByConversationId).toHaveBeenCalledWith(
			"root_recent",
			{ maxResults: 100, paginationToken: undefined },
		);
		expect(mocks.getTweetById).not.toHaveBeenCalled();
		expect(edges).toEqual([
			{ tweet_id: "mention_recent", kind: "thread_context", source: "xurl" },
			{ tweet_id: "root_recent", kind: "thread_context", source: "xurl" },
		]);
		expect(root).toEqual({ kind: "thread" });

		await syncMentionThreads({ mode: "xurl", limit: 1, delayMs: 0 });
		const edgeCount = db
			.prepare(
				"select count(*) as count from tweet_account_edges where kind = 'thread_context'",
			)
			.get() as { count: number };
		expect(edgeCount.count).toBe(2);
	});

	it("walks parents when xurl search results omit ancestors", async () => {
		setupTempHome();
		insertMention(
			"mention_missing_root",
			"recent reply without root",
			"2026-05-12T10:00:00.000Z",
		);
		upsertMentionEdge("mention_missing_root", {
			id: "mention_missing_root",
			author_id: "42",
			text: "recent reply without root",
			created_at: "2026-05-12T10:00:00.000Z",
			conversation_id: "root_missing",
			referenced_tweets: [{ type: "replied_to", id: "parent_missing" }],
		});
		mocks.searchRecentByConversationId.mockResolvedValueOnce({
			data: [
				{
					id: "mention_missing_root",
					author_id: "42",
					text: "recent reply without root",
					created_at: "2026-05-12T10:00:00.000Z",
					conversation_id: "root_missing",
					referenced_tweets: [{ type: "replied_to", id: "parent_missing" }],
					in_reply_to_user_id: "43",
				},
			],
			includes: { users: [{ id: "42", username: "sam", name: "Sam" }] },
			meta: { result_count: 1 },
		});
		mocks.getTweetById
			.mockResolvedValueOnce({
				data: [
					{
						id: "parent_missing",
						author_id: "43",
						text: "missing parent",
						created_at: "2026-05-12T09:55:00.000Z",
						conversation_id: "root_missing",
						referenced_tweets: [{ type: "replied_to", id: "root_missing" }],
						in_reply_to_user_id: "25401953",
					},
				],
				includes: { users: [{ id: "43", username: "alex", name: "Alex" }] },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "root_missing",
						author_id: "25401953",
						text: "missing root",
						created_at: "2026-05-12T09:50:00.000Z",
						conversation_id: "root_missing",
					},
				],
				includes: {
					users: [{ id: "25401953", username: "steipete", name: "Peter" }],
				},
			});
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			mode: "xurl",
			limit: 1,
			delayMs: 0,
		});
		const rows = getNativeDb()
			.prepare(
				"select id, reply_to_id from tweets where id in (?, ?, ?) order by id",
			)
			.all("mention_missing_root", "parent_missing", "root_missing");

		expect(mocks.getTweetById).toHaveBeenNthCalledWith(1, "parent_missing");
		expect(mocks.getTweetById).toHaveBeenNthCalledWith(2, "root_missing");
		expect(result).toMatchObject({
			mergedTweets: 3,
			generalReadTweets: 3,
			results: [
				expect.objectContaining({
					tweetId: "mention_missing_root",
					strategy: "conversation_search+parent_walk",
					fallbackDepth: 2,
					count: 3,
				}),
			],
			warnings: expect.arrayContaining([
				"recent search missed ancestor parent_missing for conversation root_missing; used parent walk",
			]),
		});
		expect(rows).toEqual([
			{ id: "mention_missing_root", reply_to_id: "parent_missing" },
			{ id: "parent_missing", reply_to_id: "root_missing" },
			{ id: "root_missing", reply_to_id: null },
		]);
	});

	it("preserves authored tweet kind when xurl context upserts the same tweet", async () => {
		setupTempHome();
		insertMention(
			"mention_to_authored",
			"reply to authored",
			"2026-05-12T10:00:00.000Z",
		);
		getNativeDb()
			.prepare(
				`
	    insert into tweets (
	      id, account_id, author_profile_id, kind, text, created_at,
	      is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
	      entities_json, media_json, quoted_tweet_id
	    ) values (
	      'authored_context', 'acct_primary', 'profile_user_25401953',
	      'authored', 'authored original', '2026-05-12T09:58:00.000Z',
	      0, null, 1, 0, 0, 0, '{}', '[]', null
	    )
	    `,
			)
			.run();
		upsertMentionEdge("mention_to_authored", {
			id: "mention_to_authored",
			author_id: "42",
			text: "reply to authored",
			created_at: "2026-05-12T10:00:00.000Z",
			conversation_id: "authored_context",
		});
		mocks.searchRecentByConversationId.mockResolvedValueOnce({
			data: [
				{
					id: "authored_context",
					author_id: "25401953",
					text: "authored original with fresh context",
					created_at: "2026-05-12T09:58:00.000Z",
					conversation_id: "authored_context",
					public_metrics: { like_count: 5 },
				},
				{
					id: "mention_to_authored",
					author_id: "42",
					text: "reply to authored",
					created_at: "2026-05-12T10:00:00.000Z",
					conversation_id: "authored_context",
					referenced_tweets: [{ type: "replied_to", id: "authored_context" }],
				},
			],
			includes: {
				users: [
					{ id: "25401953", username: "steipete", name: "Peter" },
					{ id: "42", username: "sam", name: "Sam" },
				],
			},
			meta: { result_count: 2 },
		});
		const { syncMentionThreads } = await import("./mention-threads-live");

		await syncMentionThreads({ mode: "xurl", limit: 1, delayMs: 0 });

		const row = getNativeDb()
			.prepare("select kind, text, like_count from tweets where id = ?")
			.get("authored_context");
		expect(row).toEqual({
			kind: "authored",
			text: "authored original with fresh context",
			like_count: 5,
		});
	});

	it("prefers fetched anchor data when cached xurl mentions lack parent metadata", async () => {
		setupTempHome();
		insertMention(
			"mention_anchor_lookup",
			"cached mention without reference data",
			"2026-05-05T11:00:00.000Z",
		);
		upsertMentionEdge("mention_anchor_lookup", {
			id: "mention_anchor_lookup",
			author_id: "42",
			text: "cached mention without reference data",
			created_at: "2026-05-05T11:00:00.000Z",
			conversation_id: "root_anchor_lookup",
		});
		mocks.searchRecentByConversationId.mockResolvedValueOnce({
			data: [],
			meta: { result_count: 0 },
		});
		mocks.getTweetById
			.mockResolvedValueOnce({
				data: [
					{
						id: "mention_anchor_lookup",
						author_id: "42",
						text: "fresh mention with reference data",
						created_at: "2026-05-05T11:00:00.000Z",
						conversation_id: "root_anchor_lookup",
						referenced_tweets: [
							{ type: "replied_to", id: "parent_anchor_lookup" },
						],
						in_reply_to_user_id: "43",
					},
				],
				includes: { users: [{ id: "42", username: "sam", name: "Sam" }] },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "parent_anchor_lookup",
						author_id: "43",
						text: "fresh parent",
						created_at: "2026-05-05T10:58:00.000Z",
						conversation_id: "root_anchor_lookup",
					},
				],
				includes: { users: [{ id: "43", username: "alex", name: "Alex" }] },
			});
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			mode: "xurl",
			limit: 1,
			delayMs: 0,
		});
		const row = getNativeDb()
			.prepare("select text, reply_to_id from tweets where id = ?")
			.get("mention_anchor_lookup");

		expect(mocks.getTweetById).toHaveBeenNthCalledWith(
			1,
			"mention_anchor_lookup",
		);
		expect(mocks.getTweetById).toHaveBeenNthCalledWith(
			2,
			"parent_anchor_lookup",
		);
		expect(result).toMatchObject({
			mergedTweets: 2,
			generalReadTweets: 2,
			results: [
				expect.objectContaining({
					tweetId: "mention_anchor_lookup",
					strategy: "parent_walk",
					fallbackDepth: 1,
					count: 2,
				}),
			],
		});
		expect(row).toEqual({
			text: "fresh mention with reference data",
			reply_to_id: "parent_anchor_lookup",
		});
	});

	it("falls back to walking the xurl parent chain for older conversations", async () => {
		setupTempHome();
		insertMention("mention_old", "old mention", "2026-05-05T11:00:00.000Z");
		upsertMentionEdge(
			"mention_old",
			{
				id: "mention_old",
				author_id: "42",
				text: "old mention",
				created_at: "2026-05-05T11:00:00.000Z",
				conversation_id: "root_old",
				referenced_tweets: [{ type: "replied_to", id: "parent_old" }],
			},
			"2026-05-12T10:00:00.000Z",
			"bird",
		);
		mocks.searchRecentByConversationId.mockResolvedValueOnce({
			data: [],
			meta: { result_count: 0 },
		});
		mocks.getTweetById
			.mockResolvedValueOnce({
				data: [
					{
						id: "parent_old",
						author_id: "43",
						text: "parent post",
						created_at: "2026-05-01T09:55:00.000Z",
						conversation_id: "root_old",
						referenced_tweets: [{ type: "replied_to", id: "root_old" }],
						in_reply_to_user_id: "25401953",
					},
				],
				includes: { users: [{ id: "43", username: "alex", name: "Alex" }] },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "root_old",
						author_id: "25401953",
						text: "root old",
						created_at: "2026-05-01T09:50:00.000Z",
						conversation_id: "root_old",
					},
				],
				includes: {
					users: [{ id: "25401953", username: "steipete", name: "Peter" }],
				},
			});
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			mode: "xurl",
			limit: 1,
			delayMs: 0,
		});
		const chainRows = getNativeDb()
			.prepare(
				"select id, kind, reply_to_id from tweets where id in (?, ?, ?) order by id",
			)
			.all("mention_old", "parent_old", "root_old");

		expect(mocks.searchRecentByConversationId).toHaveBeenCalledWith(
			"root_old",
			{ maxResults: 100, paginationToken: undefined },
		);
		expect(mocks.getTweetById).toHaveBeenNthCalledWith(1, "parent_old");
		expect(mocks.getTweetById).toHaveBeenNthCalledWith(2, "root_old");
		expect(result).toMatchObject({
			source: "xurl",
			mergedTweets: 3,
			generalReadTweets: 2,
			results: [
				expect.objectContaining({
					tweetId: "mention_old",
					strategy: "parent_walk",
					fallbackDepth: 2,
					count: 3,
				}),
			],
		});
		expect(chainRows).toEqual([
			{ id: "mention_old", kind: "mention", reply_to_id: "parent_old" },
			{ id: "parent_old", kind: "thread", reply_to_id: "root_old" },
			{ id: "root_old", kind: "thread", reply_to_id: null },
		]);
	});

	it("caps xurl fallback parent walks at twelve hops", async () => {
		setupTempHome();
		insertMention("mention_deep", "deep mention", "2026-05-05T11:00:00.000Z");
		upsertMentionEdge("mention_deep", {
			id: "mention_deep",
			author_id: "42",
			text: "deep mention",
			created_at: "2026-05-05T11:00:00.000Z",
			conversation_id: "root_deep",
			referenced_tweets: [{ type: "replied_to", id: "parent_1" }],
		});
		mocks.searchRecentByConversationId.mockResolvedValueOnce({
			data: [],
			meta: { result_count: 0 },
		});
		for (let index = 1; index <= 12; index += 1) {
			mocks.getTweetById.mockResolvedValueOnce({
				data: [
					{
						id: `parent_${String(index)}`,
						author_id: "42",
						text: `parent ${String(index)}`,
						created_at: "2026-05-01T09:00:00.000Z",
						conversation_id: "root_deep",
						referenced_tweets: [
							{ type: "replied_to", id: `parent_${String(index + 1)}` },
						],
						in_reply_to_user_id: "43",
					},
				],
			});
		}
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			mode: "xurl",
			limit: 1,
			delayMs: 0,
		});

		expect(mocks.getTweetById).toHaveBeenCalledTimes(12);
		expect(mocks.getTweetById).not.toHaveBeenCalledWith("parent_13");
		expect(result).toMatchObject({
			warnings: expect.arrayContaining([
				"fallback parent-chain depth cap reached for mention_deep after 12 hops",
			]),
			results: [
				expect.objectContaining({
					tweetId: "mention_deep",
					strategy: "parent_walk",
					fallbackDepth: 12,
					count: 13,
					warnings: expect.arrayContaining([
						"fallback parent-chain depth cap reached for mention_deep after 12 hops",
					]),
				}),
			],
		});
	});

	it("validates mention thread sync options", async () => {
		setupTempHome();
		const { syncMentionThreads } = await import("./mention-threads-live");

		await expect(syncMentionThreads({ limit: 0 })).rejects.toThrow(
			"--limit must be at least 1",
		);
		await expect(syncMentionThreads({ delayMs: -1 })).rejects.toThrow(
			"--delay-ms must be non-negative",
		);
		await expect(syncMentionThreads({ timeoutMs: 0 })).rejects.toThrow(
			"--timeout-ms must be at least 1",
		);
		await expect(syncMentionThreads({ maxPages: -1 })).rejects.toThrow(
			"--max-pages must be non-negative",
		);
		await expect(syncMentionThreads({ mode: "auto" })).rejects.toThrow(
			"--mode must be bird or xurl",
		);
		await expect(syncMentionThreads({ account: "missing" })).rejects.toThrow(
			"Unknown account: missing",
		);
	});
});
