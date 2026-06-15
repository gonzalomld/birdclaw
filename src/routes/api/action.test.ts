// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const addBlockMock = vi.fn();
const createPostMock = vi.fn();
const createTweetReplyMock = vi.fn();
const createDmReplyMock = vi.fn();
const removeBlockMock = vi.fn();
const addMuteMock = vi.fn();
const removeMuteMock = vi.fn();
const scoreInboxMock = vi.fn();
const syncBlocksMock = vi.fn();

vi.mock("#/lib/blocks", () => ({
	addBlock: (...args: unknown[]) => addBlockMock(...args),
	addBlockEffect: (...args: unknown[]) =>
		Effect.tryPromise(() => Promise.resolve(addBlockMock(...args))),
	removeBlock: (...args: unknown[]) => removeBlockMock(...args),
	removeBlockEffect: (...args: unknown[]) =>
		Effect.tryPromise(() => Promise.resolve(removeBlockMock(...args))),
	syncBlocks: (...args: unknown[]) => syncBlocksMock(...args),
	syncBlocksEffect: (...args: unknown[]) =>
		Effect.tryPromise(() => Promise.resolve(syncBlocksMock(...args))),
}));

vi.mock("#/lib/query-actions", () => ({
	createPost: (...args: unknown[]) => createPostMock(...args),
	createPostEffect: (...args: unknown[]) =>
		Effect.tryPromise(() => Promise.resolve(createPostMock(...args))),
	createTweetReply: (...args: unknown[]) => createTweetReplyMock(...args),
	createTweetReplyEffect: (...args: unknown[]) =>
		Effect.tryPromise(() => Promise.resolve(createTweetReplyMock(...args))),
	createDmReply: (...args: unknown[]) => createDmReplyMock(...args),
	createDmReplyEffect: (...args: unknown[]) =>
		Effect.tryPromise(() => Promise.resolve(createDmReplyMock(...args))),
}));

vi.mock("#/lib/mutes", () => ({
	addMute: (...args: unknown[]) => addMuteMock(...args),
	addMuteEffect: (...args: unknown[]) =>
		Effect.tryPromise(() => Promise.resolve(addMuteMock(...args))),
	removeMute: (...args: unknown[]) => removeMuteMock(...args),
	removeMuteEffect: (...args: unknown[]) =>
		Effect.tryPromise(() => Promise.resolve(removeMuteMock(...args))),
}));

vi.mock("#/lib/inbox", () => ({
	scoreInbox: (...args: unknown[]) => scoreInboxMock(...args),
	scoreInboxEffect: (...args: unknown[]) =>
		Effect.tryPromise(() => Promise.resolve(scoreInboxMock(...args))),
}));

import { Route } from "./action";

const POST = getRouteHandler(Route, "POST");

describe("api action route", () => {
	beforeEach(() => {
		addBlockMock.mockReset();
		createPostMock.mockReset();
		createTweetReplyMock.mockReset();
		createDmReplyMock.mockReset();
		removeBlockMock.mockReset();
		addMuteMock.mockReset();
		removeMuteMock.mockReset();
		scoreInboxMock.mockReset();
		syncBlocksMock.mockReset();
	});

	it("dispatches scoreInbox actions", async () => {
		scoreInboxMock.mockResolvedValue({ ok: true });
		const response = await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({
					kind: "scoreInbox",
					scoreKind: "mixed",
					limit: 4,
				}),
			}),
		});

		expect(scoreInboxMock).toHaveBeenCalledWith({
			kind: "mixed",
			account: undefined,
			limit: 4,
		});
		expect(response.status).toBe(200);
	});

	it("dispatches post actions", async () => {
		createPostMock.mockResolvedValue({ ok: true, tweetId: "tweet_007" });
		const response = await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({
					kind: "post",
					accountId: "acct_studio",
					text: "Ship more local software",
				}),
			}),
		});

		expect(createPostMock).toHaveBeenCalledWith(
			"acct_studio",
			"Ship more local software",
		);
		expect(await response.json()).toEqual({ ok: true, tweetId: "tweet_007" });
	});

	it("returns structured errors when actions fail", async () => {
		createPostMock.mockRejectedValue(new Error("transport down"));

		const response = await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({
					kind: "post",
					accountId: "acct_studio",
					text: "Will retry.",
				}),
			}),
		});

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			ok: false,
			message: "transport down",
		});
	});

	it("dispatches tweet reply actions", async () => {
		createTweetReplyMock.mockResolvedValue({
			ok: true,
			replyId: "tweet_reply",
		});
		const response = await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({
					kind: "replyTweet",
					accountId: "acct_primary",
					tweetId: "tweet_004",
					text: "Worth replying fast.",
				}),
			}),
		});

		expect(createTweetReplyMock).toHaveBeenCalledWith(
			"acct_primary",
			"tweet_004",
			"Worth replying fast.",
		);
		expect(response.status).toBe(200);
	});

	it("dispatches dm reply actions", async () => {
		createDmReplyMock.mockResolvedValue({ ok: true, messageId: "msg_009" });
		const response = await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({
					kind: "replyDm",
					conversationId: "dm_003",
					text: "Send the mock.",
				}),
			}),
		});

		expect(createDmReplyMock).toHaveBeenCalledWith("dm_003", "Send the mock.");
		expect(response.status).toBe(200);
	});

	it("dispatches blocklist actions", async () => {
		addBlockMock.mockResolvedValue({ ok: true, action: "block" });
		removeBlockMock.mockResolvedValue({ ok: true, action: "unblock" });
		addMuteMock.mockResolvedValue({ ok: true, action: "mute" });
		removeMuteMock.mockResolvedValue({ ok: true, action: "unmute" });
		syncBlocksMock.mockResolvedValue({ ok: true, synced: true });

		await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({
					kind: "blockProfile",
					accountId: "acct_primary",
					query: "@sam",
				}),
			}),
		});
		await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({
					kind: "unblockProfile",
					accountId: "acct_primary",
					query: "@sam",
				}),
			}),
		});
		await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({
					kind: "muteProfile",
					accountId: "acct_primary",
					query: "@sam",
					transport: "xurl",
				}),
			}),
		});
		await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({
					kind: "unmuteProfile",
					accountId: "acct_primary",
					query: "@sam",
					transport: "bird",
				}),
			}),
		});
		await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({
					kind: "syncBlocks",
					accountId: "acct_primary",
				}),
			}),
		});

		expect(addBlockMock).toHaveBeenCalledWith("acct_primary", "@sam", {
			transport: undefined,
		});
		expect(removeBlockMock).toHaveBeenCalledWith("acct_primary", "@sam", {
			transport: undefined,
		});
		expect(addMuteMock).toHaveBeenCalledWith("acct_primary", "@sam", {
			transport: "xurl",
		});
		expect(removeMuteMock).toHaveBeenCalledWith("acct_primary", "@sam", {
			transport: "bird",
		});
		expect(syncBlocksMock).toHaveBeenCalledWith("acct_primary");
	});

	it("rejects unknown actions", async () => {
		const response = await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({ kind: "wat" }),
			}),
		});

		expect(response.status).toBe(400);
	});

	it("uses fallback values when post payload fields are missing", async () => {
		createPostMock.mockResolvedValue({ ok: true });

		await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({ kind: "post" }),
			}),
		});

		expect(createPostMock).toHaveBeenCalledWith("acct_primary", "");
	});

	it("uses fallback values when tweet reply payload fields are missing", async () => {
		createTweetReplyMock.mockResolvedValue({ ok: true });

		await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({ kind: "replyTweet" }),
			}),
		});

		expect(createTweetReplyMock).toHaveBeenCalledWith("acct_primary", "", "");
	});

	it("uses fallback values when dm reply payload fields are missing", async () => {
		createDmReplyMock.mockResolvedValue({ ok: true });

		await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({ kind: "replyDm" }),
			}),
		});

		expect(createDmReplyMock).toHaveBeenCalledWith("", "");
	});

	it("uses score defaults when score payload fields are missing", async () => {
		scoreInboxMock.mockResolvedValue({ ok: true });

		await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({ kind: "scoreInbox" }),
			}),
		});

		expect(scoreInboxMock).toHaveBeenCalledWith({
			kind: "mixed",
			account: undefined,
			limit: 8,
		});
	});

	it("uses fallback values when block payload fields are missing", async () => {
		addBlockMock.mockResolvedValue({ ok: true });
		removeBlockMock.mockResolvedValue({ ok: true });
		addMuteMock.mockResolvedValue({ ok: true });
		removeMuteMock.mockResolvedValue({ ok: true });
		syncBlocksMock.mockResolvedValue({ ok: true });

		await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({ kind: "blockProfile" }),
			}),
		});
		await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({ kind: "unblockProfile" }),
			}),
		});
		await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({ kind: "muteProfile" }),
			}),
		});
		await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({ kind: "unmuteProfile" }),
			}),
		});
		await POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({ kind: "syncBlocks" }),
			}),
		});

		expect(addBlockMock).toHaveBeenCalledWith("acct_primary", "", {
			transport: undefined,
		});
		expect(removeBlockMock).toHaveBeenCalledWith("acct_primary", "", {
			transport: undefined,
		});
		expect(addMuteMock).toHaveBeenCalledWith("acct_primary", "", {
			transport: undefined,
		});
		expect(removeMuteMock).toHaveBeenCalledWith("acct_primary", "", {
			transport: undefined,
		});
		expect(syncBlocksMock).toHaveBeenCalledWith("acct_primary");
	});
});
