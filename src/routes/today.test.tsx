import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./today";

const TodayRoute = Route.options.component as ComponentType;

const authorProfile = {
	id: "profile_alice",
	handle: "alice",
	displayName: "Alice",
	bio: "Builds useful things.",
	followersCount: 1200,
	followingCount: 200,
	avatarHue: 42,
	createdAt: "2020-01-01T00:00:00.000Z",
};

function digestResult(label: string, markdown: string, includeDms = false) {
	return {
		context: {
			window: {
				label,
				since: "2026-05-16T00:00:00.000Z",
				until: "2026-05-16T12:00:00.000Z",
			},
			includeDms,
			counts: {
				home: 3,
				mentions: 2,
				authored: 1,
				likes: 1,
				bookmarks: 1,
				dms: includeDms ? 1 : 0,
				links: 4,
			},
			tweets: [
				{
					id: "tweet_1",
					url: "https://x.com/alice/status/tweet_1",
					source: "mentions",
					author: "alice",
					name: "Alice",
					authorProfile,
					createdAt: "2026-05-16T10:00:00.000Z",
					text: "Peter should see this.",
					likeCount: 12,
					liked: false,
					bookmarked: false,
					needsReply: true,
				},
			],
			dms: [],
			links: [],
			hash: label,
		},
		digest: {
			title: label,
			summary: `${label} summary`,
			keyTopics: [
				{
					title: "Useful signal",
					summary: "Alice shared something worth a reply.",
					tweetIds: ["tweet_1"],
					handles: ["@alice"],
				},
			],
			notableLinks: [
				{
					title: "Example",
					url: "https://example.com",
					why: "Worth reading.",
					sourceTweetIds: ["tweet_1"],
				},
				{
					title: "Unsafe",
					url: "javascript:alert(1)",
					why: "Should render as inert text.",
					sourceTweetIds: ["tweet_1"],
				},
			],
			people: [
				{ handle: "alice", name: "Alice", why: "Shared useful signal." },
			],
			actionItems: [
				{ kind: "reply", label: "Reply to Alice", tweetId: "tweet_1" },
			],
			sourceTweetIds: ["tweet_1"],
		},
		markdown,
		model: "gpt-5.5",
		reasoningEffort: "medium",
		serviceTier: "priority",
		cached: false,
		updatedAt: "2026-05-16T12:00:00.000Z",
	};
}

function ndjsonResponse(events: unknown[]) {
	const body = events.map((event) => `${JSON.stringify(event)}\n`).join("");
	return new Response(body, {
		headers: { "content-type": "application/x-ndjson" },
	});
}

describe("today route", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("streams a digest and reloads when controls change", async () => {
		const urls: URL[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			urls.push(url);
			const period = url.searchParams.get("period") ?? "today";
			const includeDms = url.searchParams.get("includeDms") === "true";
			const label = period === "week" ? "Last 7 days" : "Today";
			const markdown = includeDms
				? "# With DMs\n\n- **Reply:** ask @alice about tweet_1"
				: `# ${label}\n\n- **Reply:** ask @alice about tweet_1`;
			return ndjsonResponse([
				{ type: "delta", delta: `${markdown}\n` },
				{ type: "done", result: digestResult(label, markdown, includeDms) },
			]);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<TodayRoute />);

		expect(await screen.findByText("Today summary")).toBeInTheDocument();
		expect(screen.getByText("Useful signal")).toBeInTheDocument();
		expect(screen.getAllByText("Alice").length).toBeGreaterThan(0);
		expect(screen.queryByText("# Today")).not.toBeInTheDocument();
		expect(
			screen.getAllByText((_, element) => element?.textContent === "Today")
				.length,
		).toBeGreaterThan(0);
		expect(
			screen.getAllByText(
				(_, element) => element?.textContent === "reply: Reply to Alice",
			).length,
		).toBeGreaterThan(0);
		expect(screen.getByRole("link", { name: "Example" })).toHaveAttribute(
			"href",
			"https://example.com/",
		);
		expect(screen.getByText("Unsafe").closest("a")).toBeNull();
		expect(
			screen.getByText("3 home · 2 mentions · 4 links"),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Week" }));
		expect(await screen.findByText("Last 7 days summary")).toBeInTheDocument();

		fireEvent.click(screen.getByLabelText("DMs"));
		expect(await screen.findByText("With DMs")).toBeInTheDocument();
		expect(
			screen.getByText("3 home · 2 mentions · 4 links · 1 DMs"),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
		await waitFor(() =>
			expect(
				urls.some((url) => url.searchParams.get("refresh") === "true"),
			).toBe(true),
		);
		expect(
			urls.some(
				(url) =>
					url.searchParams.get("period") === "week" &&
					url.searchParams.get("includeDms") === "true",
			),
		).toBe(true);
	});

	it("shows request errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							ok: false,
							message:
								"Remote API access requires BIRDCLAW_ALLOW_REMOTE_WEB=1 for a trusted private proxy, or BIRDCLAW_WEB_TOKEN for tokened access",
						}),
						{
							headers: { "content-type": "application/json" },
							status: 403,
						},
					),
			),
		);

		render(<TodayRoute />);

		expect(
			await screen.findByText(
				"Digest request failed (403): Remote API access requires BIRDCLAW_ALLOW_REMOTE_WEB=1 for a trusted private proxy, or BIRDCLAW_WEB_TOKEN for tokened access",
			),
		).toBeInTheDocument();
	});

	it("shows streamed error events", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				ndjsonResponse([{ type: "error", error: "model failed" }]),
			),
		);

		render(<TodayRoute />);

		expect(await screen.findByText("model failed")).toBeInTheDocument();
	});
});
