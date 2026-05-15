import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TweetMediaGrid } from "./TweetMediaGrid";

describe("TweetMediaGrid", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders nothing without media", () => {
		const { container } = render(<TweetMediaGrid items={[]} />);

		expect(container).toBeEmptyDOMElement();
	});

	it("renders images, fallback media labels, and caps the grid at four items", () => {
		const { container } = render(
			<TweetMediaGrid
				items={[
					{
						url: "https://example.com/one.jpg",
						type: "image",
						thumbnailUrl: "https://example.com/one-thumb.jpg",
					},
					{
						url: "https://example.com/two.mp4",
						type: "video",
					},
					{
						url: "https://example.com/three.gif",
						type: "gif",
					},
					{
						url: "https://example.com/four.bin",
						type: "unknown",
					},
					{
						url: "https://example.com/five.jpg",
						type: "image",
					},
				]}
			/>,
		);

		expect(container.firstChild).toHaveClass("tweet-media-grid-4");
		expect(screen.getByAltText("Tweet media 1")).toHaveAttribute(
			"src",
			"https://example.com/one-thumb.jpg",
		);
		expect(screen.getByText("Video")).toBeInTheDocument();
		expect(screen.getByText("GIF")).toBeInTheDocument();
		expect(screen.getByText("Media")).toBeInTheDocument();
		expect(
			screen.getAllByRole("button", { name: /Open tweet media/ }),
		).toHaveLength(4);
		expect(screen.queryByRole("link")).not.toBeInTheDocument();
	});

	it("opens images in an inline viewer", () => {
		render(
			<TweetMediaGrid
				items={[
					{
						url: "https://example.com/one.jpg",
						type: "image",
						width: 1200,
						height: 800,
					},
				]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));

		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.getByRole("img", { name: "Tweet media" })).toHaveAttribute(
			"src",
			"https://example.com/one.jpg",
		);
	});

	it("opens video media inline", () => {
		const { container } = render(
			<TweetMediaGrid
				items={[
					{
						url: "https://pbs.twimg.com/video-thumb.jpg",
						type: "video",
						thumbnailUrl: "https://pbs.twimg.com/video-thumb.jpg",
						variants: [
							{
								url: "https://video.twimg.com/clip.mp4",
								contentType: "video/mp4",
							},
						],
					},
				]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));

		const video = container.querySelector("video");
		expect(video).toHaveAttribute("src", "https://video.twimg.com/clip.mp4");
		expect(video).toHaveAttribute(
			"poster",
			"https://pbs.twimg.com/video-thumb.jpg",
		);
	});

	it("opens direct video CDN URLs inline without a variant", () => {
		const { container } = render(
			<TweetMediaGrid
				items={[
					{
						url: "https://video.twimg.com/ext_tw_video/clip.mp4",
						type: "video",
					},
				]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));

		expect(container.querySelector("video")).toHaveAttribute(
			"src",
			"https://video.twimg.com/ext_tw_video/clip.mp4",
		);
	});

	it("opens gif mp4 fallbacks inline as looping muted video", () => {
		const { container } = render(
			<TweetMediaGrid
				items={[
					{
						url: "/media/demo.mp4",
						type: "gif",
					},
				]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));

		const video = container.querySelector("video");
		expect(video).toHaveAttribute("src", "/media/demo.mp4");
		expect(video).toHaveAttribute("loop");
		expect(video?.muted).toBe(true);
	});

	it("does not treat variant-less video thumbnails as playable video", () => {
		const { container } = render(
			<TweetMediaGrid
				items={[
					{
						url: "https://pbs.twimg.com/ext_tw_video_thumb/video.jpg",
						type: "video",
						thumbnailUrl: "https://pbs.twimg.com/ext_tw_video_thumb/video.jpg",
					},
				]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));

		expect(container.querySelector("video")).toBeNull();
		expect(screen.getByRole("link", { name: "Open media" })).toHaveAttribute(
			"href",
			"https://pbs.twimg.com/ext_tw_video_thumb/video.jpg",
		);
		expect(screen.getByRole("link", { name: "Open media" })).toHaveAttribute(
			"target",
			"_blank",
		);
	});

	it("closes the inline viewer from the close button", () => {
		render(
			<TweetMediaGrid
				items={[
					{
						url: "https://example.com/one.jpg",
						type: "image",
					},
				]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));
		fireEvent.click(screen.getByRole("button", { name: "Close media viewer" }));

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("keeps a fallback open path for unknown media", () => {
		render(
			<TweetMediaGrid
				items={[
					{
						url: "https://example.com/archive-media.bin",
						type: "unknown",
					},
				]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));

		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Open media" })).toHaveAttribute(
			"href",
			"https://example.com/archive-media.bin",
		);
		expect(screen.getByRole("link", { name: "Open media" })).toHaveAttribute(
			"rel",
			"noreferrer",
		);
	});
});
