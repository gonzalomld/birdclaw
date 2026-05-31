import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileRouteView } from "./profiles.$handle";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function streamEvents(events: unknown[]) {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
			}
			controller.close();
		},
	});
}

function profileContext() {
	return {
		handle: "steipete",
		accountId: "account_steipete",
		accountHandle: "openclaw",
		profile: {
			id: "profile_steipete",
			handle: "steipete",
			displayName: "Peter Steinberger",
			bio: "Builder of agentic software.",
			followersCount: 123456,
			followingCount: 987,
			avatarHue: 18,
			avatarUrl: "https://pbs.twimg.com/profile_images/1/avatar.jpg",
			createdAt: "2009-03-19T22:54:05.000Z",
		},
		externalUserId: "123",
		tweets: [],
		conversations: [],
		counts: {
			tweets: 42,
			tweetPages: 1,
			conversationsScanned: 3,
			conversationTweets: 9,
			conversationPages: 2,
		},
		fetchCached: true,
		hash: "context_hash",
	};
}

describe("profile route", () => {
	it("loads /profiles/:handle as a profile header with analysis", async () => {
		const context = profileContext();
		const fetchMock = vi.fn(
			async () =>
				new Response(
					streamEvents([
						{ type: "status", label: "Fetching profile tweets" },
						{ type: "start", context, cached: true },
						{
							type: "done",
							result: {
								context,
								analysis: {},
								markdown: "Peter ships agent tools with practical taste.",
								model: "gpt-5.5",
								reasoningEffort: "medium",
								serviceTier: "priority",
								cached: true,
								updatedAt: "2026-05-31T12:00:00.000Z",
							},
						},
					]),
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<ProfileRouteView handle="steipete" />);

		expect(await screen.findByText("Peter Steinberger")).toBeInTheDocument();
		expect(screen.getByTestId("profile-cover")).toHaveClass("h-32");
		expect(screen.getByTestId("profile-avatar-overlap")).toHaveClass("-mt-8");
		expect(screen.getByText("@steipete")).toBeInTheDocument();
		expect(
			screen.getByText("Builder of agentic software."),
		).toBeInTheDocument();
		expect(
			await screen.findByText("Peter ships agent tools with practical taste."),
		).toBeInTheDocument();
		await waitFor(() => {
			const calls = fetchMock.mock.calls as unknown as Array<
				[RequestInfo | URL]
			>;
			const firstInput = calls[0]?.[0];
			expect(firstInput).toBeDefined();
			const url = new URL(String(firstInput), "http://localhost");
			expect(url.pathname).toBe("/api/profile-analysis");
			expect(url.searchParams.get("handle")).toBe("steipete");
		});
	});
});
