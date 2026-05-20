// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getConversationThread, listDmConversations } from "./queries";
import { getNativeDb, resetDatabaseForTests } from "./db";

const listDirectMessagesViaBirdMock = vi.fn();
const getAuthenticatedBirdAccountMock = vi.fn();

vi.mock("./bird", async () => {
	const { Effect } = await import("effect");
	return {
		getAuthenticatedBirdAccount: (...args: unknown[]) =>
			getAuthenticatedBirdAccountMock(...args),
		getAuthenticatedBirdAccountEffect: (...args: unknown[]) =>
			Effect.tryPromise({
				try: () => getAuthenticatedBirdAccountMock(...args),
				catch: (error) => error,
			}),
		listDirectMessagesViaBird: (...args: unknown[]) =>
			listDirectMessagesViaBirdMock(...args),
		listDirectMessagesViaBirdEffect: (...args: unknown[]) =>
			Effect.tryPromise({
				try: () => listDirectMessagesViaBirdMock(...args),
				catch: (error) => error,
			}),
	};
});

const tempDirs: string[] = [];

function makeTempHome() {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-dms-live-"));
	tempDirs.push(tempDir);
	process.env.BIRDCLAW_HOME = tempDir;
	return tempDir;
}

describe("cached live DMs", () => {
	beforeEach(() => {
		listDirectMessagesViaBirdMock.mockReset();
		getAuthenticatedBirdAccountMock.mockReset();
		getAuthenticatedBirdAccountMock.mockResolvedValue({
			id: "25401953",
			username: "steipete",
		});
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;

		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps cached DM sync effects lazy", async () => {
		makeTempHome();
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [],
			events: [],
		});
		const { syncDirectMessagesViaCachedBirdEffect } =
			await import("./dms-live");

		const effect = syncDirectMessagesViaCachedBirdEffect({
			account: "acct_primary",
			limit: 5,
			refresh: true,
		});

		expect(listDirectMessagesViaBirdMock).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			source: "bird",
			conversations: 0,
			messages: 0,
		});
		expect(listDirectMessagesViaBirdMock).toHaveBeenCalledTimes(1);
	});

	it("fetches bird DMs, caches them, and syncs them into the local store", async () => {
		makeTempHome();
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [
				{
					id: "25401953-42",
					participants: [
						{ id: "25401953", username: "steipete", name: "Peter" },
						{ id: "42", username: "sam", name: "Sam Altman" },
					],
					messages: [
						{
							id: "dm_live_1",
							conversationId: "25401953-42",
							text: "Live DM hello",
							createdAt: "2026-04-25T20:00:00.000Z",
							senderId: "42",
							recipientId: "25401953",
							sender: { id: "42", username: "sam", name: "Sam Altman" },
							recipient: {
								id: "25401953",
								username: "steipete",
								name: "Peter",
							},
						},
					],
					lastMessageAt: "2026-04-25T20:00:00.000Z",
					inboxKind: "request",
					isMessageRequest: true,
				},
			],
			events: [
				{
					id: "dm_live_1",
					conversationId: "25401953-42",
					text: "Live DM hello",
					createdAt: "2026-04-25T20:00:00.000Z",
					senderId: "42",
					recipientId: "25401953",
					sender: { id: "42", username: "sam", name: "Sam Altman" },
					recipient: { id: "25401953", username: "steipete", name: "Peter" },
				},
			],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		const summary = await syncDirectMessagesViaCachedBird({
			account: "acct_primary",
			limit: 5,
			refresh: true,
		});

		expect(summary).toEqual({
			ok: true,
			source: "bird",
			accountId: "acct_primary",
			conversations: 1,
			messages: 1,
		});
		expect(listDirectMessagesViaBirdMock).toHaveBeenCalledWith({
			maxResults: 5,
		});
		expect(listDmConversations({ search: "hello", limit: 10 })).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "25401953-42",
					accountId: "acct_primary",
					inboxKind: "request",
					isMessageRequest: true,
					needsReply: true,
					participant: expect.objectContaining({
						handle: "sam",
						displayName: "Sam Altman",
					}),
				}),
			]),
		);
		expect(listDmConversations({ inbox: "requests", limit: 10 })).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "25401953-42",
					inboxKind: "request",
					isMessageRequest: true,
				}),
			]),
		);
		expect(getConversationThread("25401953-42")?.messages).toEqual([
			expect.objectContaining({
				id: "dm_live_1",
				text: "Live DM hello",
				direction: "inbound",
				sender: expect.objectContaining({ handle: "sam" }),
			}),
		]);
	});

	it("reuses fresh cache without spending another bird call", async () => {
		makeTempHome();
		listDirectMessagesViaBirdMock.mockResolvedValue({
			success: true,
			conversations: [],
			events: [],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await syncDirectMessagesViaCachedBird({
			account: "acct_primary",
			limit: 5,
		});
		const second = await syncDirectMessagesViaCachedBird({
			account: "acct_primary",
			limit: 5,
		});

		expect(second.source).toBe("cache");
		expect(listDirectMessagesViaBirdMock).toHaveBeenCalledTimes(1);
	});

	it("validates limits and account selection", async () => {
		makeTempHome();
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(syncDirectMessagesViaCachedBird({ limit: 0 })).rejects.toThrow(
			"bird DM mode requires --limit of at least 1",
		);
		await expect(
			syncDirectMessagesViaCachedBird({ account: "missing", limit: 1 }),
		).rejects.toThrow("Unknown account: missing");
	});

	it("refuses to fetch DMs when bird is authenticated as another account", async () => {
		makeTempHome();
		getAuthenticatedBirdAccountMock.mockResolvedValueOnce({
			id: "1995710751097659392",
			username: "openclaw",
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				account: "acct_primary",
				limit: 5,
				refresh: true,
			}),
		).rejects.toThrow(
			"bird is authenticated as user 1995710751097659392; refusing to sync into acct_primary (25401953)",
		);
		expect(listDirectMessagesViaBirdMock).not.toHaveBeenCalled();
		expect(listDmConversations({ search: "Wrong account", limit: 10 })).toEqual(
			[],
		);
	});

	it("refuses payloads that do not include the configured account", async () => {
		makeTempHome();
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [
				{
					id: "999-42",
					participants: [{ id: "42", username: "sam", name: "Sam Altman" }],
					messages: [],
				},
			],
			events: [
				{
					id: "dm_live_1",
					conversationId: "999-42",
					text: "Wrong account",
					createdAt: "2026-04-25T20:00:00.000Z",
					senderId: "42",
					sender: { id: "42", username: "sam", name: "Sam Altman" },
				},
			],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				account: "acct_primary",
				limit: 5,
				refresh: true,
			}),
		).rejects.toThrow(
			"bird DM payload does not include @steipete; refusing to sync into acct_primary",
		);
	});

	it("uses the stable account id when handles or payload users are sparse", async () => {
		makeTempHome();
		getAuthenticatedBirdAccountMock.mockResolvedValueOnce({
			id: "25401953",
			username: "renamed",
		});
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [
				{
					id: "25401953-42",
					participants: [
						{ id: "25401953" },
						{ id: "42", username: "sam", name: "Sam Altman" },
					],
					messages: [],
					lastMessageAt: "2026-04-25T20:00:00.000Z",
				},
			],
			events: [
				{
					id: "dm_sparse_self",
					conversationId: "25401953-42",
					text: "Sparse self",
					createdAt: "2026-04-25T20:00:00.000Z",
					senderId: "42",
					recipientId: "25401953",
					sender: { id: "42", username: "sam", name: "Sam Altman" },
				},
			],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				account: "acct_primary",
				limit: 5,
				refresh: true,
			}),
		).resolves.toEqual(
			expect.objectContaining({
				source: "bird",
				conversations: 1,
				messages: 1,
			}),
		);
		expect(getConversationThread("25401953-42")?.messages).toEqual([
			expect.objectContaining({
				id: "dm_sparse_self",
				direction: "inbound",
			}),
		]);
	});

	it("keeps request conversations that only have a last-message preview", async () => {
		makeTempHome();
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [
				{
					id: "25401953-55",
					participants: [
						{ id: "25401953" },
						{ id: "55", username: "previewonly", name: "Preview Only" },
					],
					messages: [],
					lastMessageAt: "2026-04-25T20:00:00.000Z",
					lastMessagePreview: "Preview text without an event body",
					inboxKind: "request",
					isMessageRequest: true,
				},
			],
			events: [],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				account: "acct_primary",
				limit: 5,
				refresh: true,
			}),
		).resolves.toEqual(
			expect.objectContaining({
				source: "bird",
				conversations: 1,
				messages: 0,
			}),
		);
		expect(listDmConversations({ inbox: "requests", limit: 10 })).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "25401953-55",
					inboxKind: "request",
					isMessageRequest: true,
					lastMessagePreview: "Preview text without an event body",
					needsReply: true,
					participant: expect.objectContaining({
						handle: "previewonly",
						displayName: "Preview Only",
					}),
				}),
			]),
		);
		expect(
			listDmConversations({
				search: "Preview text",
				inbox: "requests",
				limit: 10,
			}).map((item) => item.id),
		).toEqual(["25401953-55"]);
		expect(getConversationThread("25401953-55")?.messages).toEqual([
			expect.objectContaining({
				id: "preview:25401953-55",
				text: "Preview text without an event body",
				direction: "inbound",
			}),
		]);
	});

	it("imports sparse outbound messages from the stable account id", async () => {
		makeTempHome();
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [
				{
					id: "25401953-66",
					participants: [
						{ id: "25401953" },
						{ id: "66", username: "pat", name: "Pat" },
					],
					messages: [],
				},
			],
			events: [
				{
					id: "dm_sparse_outbound",
					conversationId: "25401953-66",
					text: "Sparse outbound",
					createdAt: "2026-04-25T20:00:00.000Z",
					senderId: "25401953",
					recipientId: "66",
					recipient: { id: "66", username: "pat", name: "Pat" },
				},
			],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				account: "acct_primary",
				limit: 5,
				refresh: true,
			}),
		).resolves.toEqual(
			expect.objectContaining({
				source: "bird",
				conversations: 1,
				messages: 1,
			}),
		);
		expect(getConversationThread("25401953-66")?.messages).toEqual([
			expect.objectContaining({
				id: "dm_sparse_outbound",
				direction: "outbound",
			}),
		]);
	});

	it("uses the live bird account id when the selected account has no stored external id", async () => {
		makeTempHome();
		getNativeDb()
			.prepare("update accounts set external_user_id = null where id = ?")
			.run("acct_primary");
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [
				{
					id: "25401953-77",
					participants: [{ id: "77", username: "casey", name: "Casey" }],
					messages: [],
					lastMessageAt: "2026-04-25T20:00:00.000Z",
				},
			],
			events: [
				{
					id: "dm_sparse_live_id",
					conversationId: "25401953-77",
					text: "Sparse self from live id",
					createdAt: "2026-04-25T20:00:00.000Z",
					senderId: "77",
					sender: { id: "77", username: "casey", name: "Casey" },
				},
			],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				account: "acct_primary",
				limit: 5,
				refresh: true,
			}),
		).resolves.toEqual(
			expect.objectContaining({
				source: "bird",
				conversations: 1,
				messages: 1,
			}),
		);
		expect(getConversationThread("25401953-77")?.messages).toEqual([
			expect.objectContaining({
				id: "dm_sparse_live_id",
				direction: "inbound",
			}),
		]);
		expect(
			getNativeDb()
				.prepare("select external_user_id from accounts where id = ?")
				.get("acct_primary"),
		).toEqual({ external_user_id: "25401953" });

		const cached = await syncDirectMessagesViaCachedBird({
			account: "acct_primary",
			limit: 5,
		});

		expect(cached).toEqual(
			expect.objectContaining({
				source: "cache",
				conversations: 1,
				messages: 1,
			}),
		);
		expect(listDirectMessagesViaBirdMock).toHaveBeenCalledTimes(1);
	});

	it("treats a blank stored external id as missing", async () => {
		makeTempHome();
		getNativeDb()
			.prepare("update accounts set external_user_id = '  ' where id = ?")
			.run("acct_primary");
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [
				{
					id: "25401953-88",
					participants: [{ id: "88", username: "blankcase", name: "Blank" }],
					messages: [],
				},
			],
			events: [
				{
					id: "dm_blank_external_id",
					conversationId: "25401953-88",
					text: "Blank external id repaired",
					createdAt: "2026-04-25T20:00:00.000Z",
					senderId: "88",
					sender: { id: "88", username: "blankcase", name: "Blank" },
				},
			],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				account: "acct_primary",
				limit: 5,
				refresh: true,
			}),
		).resolves.toEqual(
			expect.objectContaining({
				source: "bird",
				conversations: 1,
				messages: 1,
			}),
		);
		expect(
			getNativeDb()
				.prepare("select external_user_id from accounts where id = ?")
				.get("acct_primary"),
		).toEqual({ external_user_id: "25401953" });
	});

	it("handles outbound latest messages and skips incomplete bird events", async () => {
		makeTempHome();
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [
				{
					id: "25401953-99",
					participants: [
						{ id: "25401953", username: "steipete", name: "Peter" },
						{ id: "99", name: "No Handle" },
					],
					messages: [],
					lastMessageAt: "bad-date",
				},
				{
					id: "empty",
					participants: [{ id: "100", username: "empty" }],
					messages: [],
				},
			],
			events: [
				{
					id: "missing_conversation",
					text: "skip no conversation id",
					senderId: "99",
					sender: { id: "99", name: "No Handle" },
				},
				{
					id: "missing_sender",
					conversationId: "25401953-99",
					text: "skip no sender",
					createdAt: "2026-04-25T19:00:00.000Z",
				},
				{
					id: "dm_outbound",
					conversationId: "25401953-99",
					text: "Outbound reply",
					createdAt: "2026-04-25T21:00:00.000Z",
					senderId: "25401953",
					recipientId: "99",
					sender: { id: "25401953", username: "steipete", name: "Peter" },
					recipient: { id: "99", name: "No Handle" },
				},
			],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				limit: 2,
				refresh: true,
				cacheTtlMs: -1,
			}),
		).resolves.toEqual(
			expect.objectContaining({
				source: "bird",
				conversations: 2,
				messages: 3,
			}),
		);
		expect(listDmConversations({ search: "Outbound", limit: 10 })).toEqual([
			expect.objectContaining({
				id: "25401953-99",
				needsReply: false,
				participant: expect.objectContaining({
					handle: "user_99",
					displayName: "No Handle",
				}),
			}),
		]);
		expect(getConversationThread("25401953-99")?.messages).toEqual([
			expect.objectContaining({
				id: "dm_outbound",
				createdAt: "2026-04-25T21:00:00.000Z",
				direction: "outbound",
			}),
		]);
	});
});
