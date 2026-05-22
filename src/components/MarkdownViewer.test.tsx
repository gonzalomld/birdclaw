import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PeriodDigestContext } from "#/lib/period-digest";
import { MarkdownViewer } from "./MarkdownViewer";

const authorProfile = {
	id: "profile_chainzenit",
	handle: "ChainZenit",
	displayName: "Strata",
	bio: "",
	followersCount: 0,
	avatarHue: 280,
	createdAt: "2026-05-18T08:00:00.000Z",
};

const context = {
	window: {
		label: "Today",
		since: "2026-05-18T00:00:00.000Z",
		until: "2026-05-18T12:00:00.000Z",
	},
	includeDms: false,
	counts: {
		home: 1,
		mentions: 1,
		authored: 0,
		likes: 0,
		bookmarks: 0,
		dms: 0,
		links: 0,
	},
	tweets: [
		{
			id: "2056286865875935400",
			url: "https://x.com/ChainZenit/status/2056286865875935400",
			source: "mentions",
			author: "ChainZenit",
			name: "Strata",
			authorProfile,
			createdAt: "2026-05-18T09:12:00.000Z",
			text: "@GOATNetwork @openclaw oh nice, autonomous agents running on goAT",
			likeCount: 0,
			liked: false,
			bookmarked: false,
			needsReply: true,
		},
		{
			id: "2057574939775938900",
			url: "https://x.com/kilocode/status/2057574939775938900",
			source: "home",
			author: "kilocode",
			name: "Kilo Code",
			authorProfile: {
				...authorProfile,
				id: "profile_kilocode",
				handle: "kilocode",
				displayName: "Kilo Code",
			},
			createdAt: "2026-05-18T10:12:00.000Z",
			text: "StepFun Step 3.5 Flash is the most-used free model in Kilo modes.",
			likeCount: 42,
			liked: false,
			bookmarked: false,
			needsReply: false,
		},
		{
			id: "2057578665408434460",
			url: "https://x.com/kilocode/status/2057578665408434460",
			source: "home",
			author: "kilocode",
			name: "Kilo Code",
			authorProfile: {
				...authorProfile,
				id: "profile_kilocode",
				handle: "kilocode",
				displayName: "Kilo Code",
			},
			createdAt: "2026-05-18T10:15:00.000Z",
			text: "BYOK access reaches Opus, GPT-5.5, Gemini 3, and more.",
			likeCount: 43,
			liked: false,
			bookmarked: false,
			needsReply: false,
		},
	],
	dms: [],
	links: [],
	hash: "demo",
} satisfies PeriodDigestContext;

describe("MarkdownViewer", () => {
	afterEach(cleanup);

	it("links generated tweet citations without showing raw ids", () => {
		render(
			<MarkdownViewer
				context={context}
				markdown={
					"ChainZenit reacted positively to “autonomous agents running on goAT” (tweet_2056286865875935400)."
				}
			/>,
		);

		expect(
			screen.queryByText(/tweet_2056286865875935400/),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("link", {
				name: "“autonomous agents running on goAT”",
			}),
		).toHaveAttribute(
			"href",
			"https://x.com/ChainZenit/status/2056286865875935400",
		);
		expect(
			screen.getByRole("link", {
				name: "“autonomous agents running on goAT”",
			}),
		).not.toHaveClass("font-mono");
	});

	it("renders normal markdown links without changing the surrounding text font", () => {
		render(
			<MarkdownViewer
				context={context}
				markdown={
					"- [Kilo update](https://example.com/kilo) mattered because BYOK access broadened (tweet_2057578665408434460)."
				}
			/>,
		);

		const link = screen.getByRole("link", { name: "Kilo update" });
		expect(link).toHaveAttribute("href", "https://example.com/kilo");
		expect(link).not.toHaveClass("font-mono");
		expect(
			screen.getByRole("link", {
				name: "mattered because BYOK access broadened",
			}),
		).toHaveAttribute(
			"href",
			"https://x.com/kilocode/status/2057578665408434460",
		);
	});

	it("renders model-emitted markdown links with spaces or wrapped URLs", () => {
		render(
			<MarkdownViewer
				context={context}
				markdown={[
					"- [Lucid Windows accessibility tool announcement] (https://x.com/zhangdao439566/status/2057755065876938783) connects desktop control to accessibility use cases.",
					"- [Kitze’s Benji rewrite thread]",
					"(https://x.com/thekitze/status/2057748944592277563) is useful for long-running product iteration.",
				].join("\n")}
			/>,
		);

		expect(
			screen.getByRole("link", {
				name: "Lucid Windows accessibility tool announcement",
			}),
		).toHaveAttribute(
			"href",
			"https://x.com/zhangdao439566/status/2057755065876938783",
		);
		expect(
			screen.getByRole("link", { name: "Kitze’s Benji rewrite thread" }),
		).toHaveAttribute(
			"href",
			"https://x.com/thekitze/status/2057748944592277563",
		);
		expect(screen.queryByText("[Kitze’s Benji rewrite thread]")).toBeNull();
	});

	it("links comma-separated tweet citations to nearby readable text", () => {
		render(
			<MarkdownViewer
				context={context}
				markdown={
					"@kilocode says StepFun is widely used, with BYOK access to Opus, GPT-5.5, Gemini 3, and 500+ models at provider cost (tweet_2057574939775938900, tweet_2057578665408434460)."
				}
			/>,
		);

		expect(
			screen.queryByText(/tweet_2057574939775938900/),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText(/tweet_2057578665408434460/),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("link", {
				name: "with BYOK access to Opus, GPT-5.5, Gemini 3, and 500+ models at provider cost",
			}),
		).toHaveAttribute(
			"href",
			"https://x.com/kilocode/status/2057574939775938900",
		);
		expect(screen.getByRole("link", { name: "source 2" })).toHaveAttribute(
			"href",
			"https://x.com/kilocode/status/2057578665408434460",
		);
	});

	it("keeps mixed unresolved grouped tweet citations visible", () => {
		render(
			<MarkdownViewer
				context={context}
				markdown={
					"@kilocode says StepFun is widely used (tweet_2057574939775938900, tweet_missing)."
				}
			/>,
		);

		expect(
			screen.getByText("(tweet_2057574939775938900, tweet_missing)", {
				exact: false,
			}),
		).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "source 2" })).toBeNull();
	});

	it("renders all grouped citation links when no readable text precedes", () => {
		render(
			<MarkdownViewer
				context={context}
				markdown={
					"**Kilo:** (tweet_2057574939775938900, tweet_2057578665408434460)."
				}
			/>,
		);

		expect(screen.getByRole("link", { name: "source 1" })).toHaveAttribute(
			"href",
			"https://x.com/kilocode/status/2057574939775938900",
		);
		expect(screen.getByRole("link", { name: "source 2" })).toHaveAttribute(
			"href",
			"https://x.com/kilocode/status/2057578665408434460",
		);
		expect(
			screen.queryByText(/tweet_2057574939775938900/),
		).not.toBeInTheDocument();
	});

	it("closes a tweet preview after opening the tweet link", () => {
		render(
			<MarkdownViewer
				context={context}
				markdown={
					"ChainZenit reacted positively to “autonomous agents running on goAT” (tweet_2056286865875935400)."
				}
			/>,
		);

		const link = screen.getByRole("link", {
			name: "“autonomous agents running on goAT”",
		});
		const wrapper = link.parentElement;
		const preview = screen
			.getByText(context.tweets[0].text)
			.closest("[aria-hidden]");

		expect(preview).toHaveAttribute("aria-hidden", "true");
		expect(wrapper).not.toBeNull();

		fireEvent.pointerEnter(wrapper as Element);
		expect(preview).toHaveAttribute("aria-hidden", "false");

		fireEvent.click(link, { metaKey: true });
		expect(preview).toHaveAttribute("aria-hidden", "true");
	});
});
