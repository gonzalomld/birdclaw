import { createFileRoute } from "@tanstack/react-router";
import {
	CalendarDays,
	CheckCircle2,
	ExternalLink,
	Loader2,
	MessageSquare,
	RefreshCw,
	Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AvatarChip } from "#/components/AvatarChip";
import { MarkdownViewer } from "#/components/MarkdownViewer";
import { formatCompactNumber, formatShortTimestamp } from "#/lib/present";
import type {
	PeriodDigestContext,
	PeriodDigestRunResult,
	PeriodDigestStreamEvent,
} from "#/lib/period-digest";
import {
	cx,
	errorCopyClass,
	pageHeaderActionsClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	secondaryButtonClass,
	segmentActiveClass,
	segmentClass,
	segmentedClass,
	statusCopyClass,
} from "#/lib/ui";

export const Route = createFileRoute("/today")({
	component: TodayRoute,
});

type PeriodOption = "today" | "24h" | "yesterday" | "week";

const periods: Array<{ value: PeriodOption; label: string }> = [
	{ value: "today", label: "Today" },
	{ value: "24h", label: "24h" },
	{ value: "yesterday", label: "Yesterday" },
	{ value: "week", label: "Week" },
];

function digestUrl(
	period: PeriodOption,
	includeDms: boolean,
	refresh: boolean,
) {
	const url = new URL("/api/period-digest", window.location.origin);
	url.searchParams.set("period", period);
	url.searchParams.set("includeDms", String(includeDms));
	if (refresh) {
		url.searchParams.set("refresh", "true");
	}
	return url;
}

async function digestRequestError(response: Response) {
	const status = `${String(response.status)}${response.statusText ? ` ${response.statusText}` : ""}`;
	let detail = "";
	try {
		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			const payload = (await response.json()) as {
				error?: unknown;
				message?: unknown;
			};
			if (typeof payload.message === "string") detail = payload.message;
			else if (typeof payload.error === "string") detail = payload.error;
		} else {
			detail = (await response.text()).trim();
		}
	} catch {
		detail = "";
	}
	return new Error(
		detail
			? `Digest request failed (${status}): ${detail}`
			: `Digest request failed (${status})`,
	);
}

function formatCounts(result: PeriodDigestRunResult | null) {
	if (!result) return "Local Twitter memory, summarized as it streams.";
	const counts = result.context.counts;
	return [
		`${String(counts.home)} home`,
		`${String(counts.mentions)} mentions`,
		`${String(counts.links)} links`,
		result.context.includeDms ? `${String(counts.dms)} DMs` : null,
	]
		.filter(Boolean)
		.join(" · ");
}

function useDigestStream(period: PeriodOption, includeDms: boolean) {
	const [markdown, setMarkdown] = useState("");
	const [context, setContext] = useState<PeriodDigestContext | null>(null);
	const [result, setResult] = useState<PeriodDigestRunResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const abortRef = useRef<AbortController | null>(null);
	const requestIdRef = useRef(0);

	const run = useCallback(
		(refresh = false) => {
			abortRef.current?.abort();
			const controller = new AbortController();
			const requestId = requestIdRef.current + 1;
			requestIdRef.current = requestId;
			abortRef.current = controller;
			const isActiveRequest = () =>
				abortRef.current === controller &&
				requestIdRef.current === requestId &&
				!controller.signal.aborted;
			setMarkdown("");
			setContext(null);
			setResult(null);
			setError(null);
			setLoading(true);

			fetch(digestUrl(period, includeDms, refresh), {
				signal: controller.signal,
			})
				.then(async (response) => {
					if (!response.ok) {
						throw await digestRequestError(response);
					}
					if (!response.body) {
						throw new Error("Digest request failed: empty response body");
					}
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					const pump = (): Promise<void> =>
						reader.read().then(({ done, value }) => {
							if (!isActiveRequest()) return;
							if (done) return;
							buffer += decoder.decode(value, { stream: true });
							let newline = buffer.indexOf("\n");
							while (newline >= 0) {
								const line = buffer.slice(0, newline).trim();
								buffer = buffer.slice(newline + 1);
								if (line) {
									const event = JSON.parse(line) as PeriodDigestStreamEvent;
									if (!isActiveRequest()) return;
									if (event.type === "start") {
										setContext(event.context);
									} else if (event.type === "delta") {
										setMarkdown((current) => current + event.delta);
									} else if (event.type === "done") {
										setResult(event.result);
										setContext(event.result.context);
										setMarkdown(event.result.markdown);
									} else if (event.type === "error") {
										setError(event.error);
									}
								}
								newline = buffer.indexOf("\n");
							}
							return pump();
						});
					return pump();
				})
				.catch((cause: unknown) => {
					if (!isActiveRequest()) return;
					setError(cause instanceof Error ? cause.message : "Digest failed");
				})
				.finally(() => {
					if (isActiveRequest()) {
						setLoading(false);
					}
				});
		},
		[includeDms, period],
	);

	useEffect(() => {
		run(false);
		return () => abortRef.current?.abort();
	}, [run]);

	return { context, error, loading, markdown, result, run };
}

function uniqueTweetIds(result: PeriodDigestRunResult) {
	const ids = new Set<string>();
	for (const topic of result.digest.keyTopics) {
		for (const id of topic.tweetIds) ids.add(id);
	}
	for (const item of result.digest.actionItems) {
		if (item.tweetId) ids.add(item.tweetId);
	}
	for (const id of result.digest.sourceTweetIds) ids.add(id);
	return ids;
}

function pickHighlightTweets(result: PeriodDigestRunResult) {
	const preferred = uniqueTweetIds(result);
	const byId = new Map(result.context.tweets.map((tweet) => [tweet.id, tweet]));
	const picked = [...preferred]
		.map((id) => byId.get(id))
		.filter((tweet): tweet is PeriodDigestContext["tweets"][number] =>
			Boolean(tweet),
		);
	const fallback = [...result.context.tweets].sort((left, right) => {
		const leftScore =
			left.likeCount + (left.needsReply ? 60 : 0) + (left.bookmarked ? 30 : 0);
		const rightScore =
			right.likeCount +
			(right.needsReply ? 60 : 0) +
			(right.bookmarked ? 30 : 0);
		if (rightScore !== leftScore) return rightScore - leftScore;
		return right.createdAt.localeCompare(left.createdAt);
	});
	for (const tweet of fallback) {
		if (!picked.some((item) => item.id === tweet.id)) picked.push(tweet);
		if (picked.length >= 4) break;
	}
	return picked.slice(0, 4);
}

function safeExternalHref(value: string) {
	try {
		const url = new URL(value);
		if (url.protocol === "http:" || url.protocol === "https:") {
			return url.href;
		}
	} catch {
		return null;
	}
	return null;
}

function DigestTweetCard({
	tweet,
}: {
	tweet: PeriodDigestContext["tweets"][number];
}) {
	return (
		<a
			className="group flex min-w-0 flex-col gap-2 rounded-lg border border-[var(--line)] bg-[var(--bg-elevated)] p-3 text-[var(--ink)] transition-colors hover:bg-[var(--bg-hover)]"
			href={tweet.url}
			rel="noreferrer"
			target="_blank"
		>
			<span className="flex items-center gap-2">
				<AvatarChip
					avatarUrl={tweet.authorProfile.avatarUrl}
					hue={tweet.authorProfile.avatarHue}
					name={tweet.name}
					profileId={tweet.authorProfile.id}
					size="small"
				/>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-[14px] font-bold">
						{tweet.name}
					</span>
					<span className="block truncate text-[12px] text-[var(--ink-soft)]">
						@{tweet.author} · {formatShortTimestamp(tweet.createdAt)}
					</span>
				</span>
				<ExternalLink className="size-3.5 text-[var(--ink-soft)] opacity-0 transition-opacity group-hover:opacity-100" />
			</span>
			<span className="line-clamp-4 text-[14px] leading-5 [overflow-wrap:anywhere]">
				{tweet.text}
			</span>
			<span className="flex items-center gap-3 text-[12px] text-[var(--ink-soft)]">
				<span>{tweet.source}</span>
				{tweet.likeCount > 0 ? (
					<span>{formatCompactNumber(tweet.likeCount)} likes</span>
				) : null}
				{tweet.needsReply ? <span>reply open</span> : null}
			</span>
		</a>
	);
}

function DigestLinkItem({
	link,
}: {
	link: PeriodDigestRunResult["digest"]["notableLinks"][number];
}) {
	const href = safeExternalHref(link.url);

	return (
		<li>
			{href ? (
				<a
					className="font-bold text-[var(--accent)] hover:underline"
					href={href}
					rel="noreferrer"
					target="_blank"
				>
					{link.title}
				</a>
			) : (
				<span className="font-bold text-[var(--ink)]">{link.title}</span>
			)}
			<p className="text-[var(--ink-soft)]">{link.why}</p>
		</li>
	);
}

function DigestOverview({ result }: { result: PeriodDigestRunResult }) {
	const highlights = pickHighlightTweets(result);
	const hasOverview =
		result.digest.summary ||
		result.digest.keyTopics.length > 0 ||
		highlights.length > 0 ||
		result.digest.notableLinks.length > 0 ||
		result.digest.people.length > 0;

	if (!hasOverview) return null;

	return (
		<section className="border-b border-[var(--line)] px-4 py-4">
			<div className="grid gap-3">
				{result.digest.summary ? (
					<div className="rounded-lg border border-[var(--line)] bg-[var(--bg-elevated)] p-3">
						<p className="text-[15px] leading-6 text-[var(--ink)]">
							{result.digest.summary}
						</p>
					</div>
				) : null}

				{result.digest.keyTopics.length > 0 ? (
					<div className="grid gap-2">
						<h2 className="text-[13px] font-bold uppercase tracking-wide text-[var(--ink-soft)]">
							Signal
						</h2>
						<div className="grid gap-2">
							{result.digest.keyTopics.slice(0, 4).map((topic) => (
								<div
									className="rounded-lg border border-[var(--line)] bg-[var(--bg-elevated)] p-3"
									key={topic.title}
								>
									<h3 className="text-[15px] font-bold">{topic.title}</h3>
									<p className="mt-1 text-[14px] leading-5 text-[var(--ink-soft)]">
										{topic.summary}
									</p>
								</div>
							))}
						</div>
					</div>
				) : null}

				{highlights.length > 0 ? (
					<div className="grid gap-2">
						<h2 className="text-[13px] font-bold uppercase tracking-wide text-[var(--ink-soft)]">
							Highlight tweets
						</h2>
						<div className="grid gap-2 min-[720px]:grid-cols-2">
							{highlights.map((tweet) => (
								<DigestTweetCard key={tweet.id} tweet={tweet} />
							))}
						</div>
					</div>
				) : null}

				{result.digest.notableLinks.length > 0 ||
				result.digest.people.length > 0 ? (
					<div className="grid gap-2 min-[720px]:grid-cols-2">
						{result.digest.notableLinks.length > 0 ? (
							<div className="rounded-lg border border-[var(--line)] bg-[var(--bg-elevated)] p-3">
								<h2 className="mb-2 text-[13px] font-bold uppercase tracking-wide text-[var(--ink-soft)]">
									Links
								</h2>
								<ul className="flex flex-col gap-2 text-[14px]">
									{result.digest.notableLinks.slice(0, 4).map((link) => (
										<DigestLinkItem
											key={`${link.title}:${link.url}`}
											link={link}
										/>
									))}
								</ul>
							</div>
						) : null}
						{result.digest.people.length > 0 ? (
							<div className="rounded-lg border border-[var(--line)] bg-[var(--bg-elevated)] p-3">
								<h2 className="mb-2 text-[13px] font-bold uppercase tracking-wide text-[var(--ink-soft)]">
									People
								</h2>
								<ul className="flex flex-col gap-2 text-[14px]">
									{result.digest.people.slice(0, 5).map((person) => (
										<li key={person.handle}>
											<a
												className="font-bold text-[var(--accent)] hover:underline"
												href={`https://x.com/${person.handle.replace(/^@/, "")}`}
												rel="noreferrer"
												target="_blank"
											>
												{person.name ?? person.handle}
											</a>
											<p className="text-[var(--ink-soft)]">{person.why}</p>
										</li>
									))}
								</ul>
							</div>
						) : null}
					</div>
				) : null}
			</div>
		</section>
	);
}

function TodayRoute() {
	const [period, setPeriod] = useState<PeriodOption>("today");
	const [includeDms, setIncludeDms] = useState(false);
	const { context, error, loading, markdown, result, run } = useDigestStream(
		period,
		includeDms,
	);
	const actionCount = result?.digest.actionItems.length ?? 0;
	const sourceLabel = useMemo(() => formatCounts(result), [result]);

	return (
		<div className="flex min-h-screen flex-col">
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div className="min-w-0">
						<h1 className={pageTitleClass}>What happened</h1>
						<p className={pageSubtitleClass}>{sourceLabel}</p>
					</div>
					<div className={pageHeaderActionsClass}>
						<button
							type="button"
							className={secondaryButtonClass}
							onClick={() => run(true)}
							disabled={loading}
						>
							<RefreshCw
								className={cx("size-4", loading && "animate-spin")}
								aria-hidden="true"
							/>
							Refresh
						</button>
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-2 px-4 pb-3">
					<div className={segmentedClass} aria-label="Digest period">
						{periods.map((item) => (
							<button
								key={item.value}
								type="button"
								className={cx(
									segmentClass,
									period === item.value && segmentActiveClass,
								)}
								onClick={() => setPeriod(item.value)}
							>
								{item.label}
							</button>
						))}
					</div>
					<label className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] px-3 py-1 text-[13px] font-medium text-[var(--ink-soft)]">
						<input
							type="checkbox"
							checked={includeDms}
							onChange={(event) => setIncludeDms(event.currentTarget.checked)}
						/>
						DMs
					</label>
				</div>
			</header>

			{error ? <div className={errorCopyClass}>{error}</div> : null}

			<section className="flex flex-col gap-4 border-b border-[var(--line)] px-4 py-4">
				<div className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--ink-soft)]">
					<span className="inline-flex items-center gap-1">
						{loading ? (
							<Loader2 className="size-4 animate-spin" aria-hidden="true" />
						) : (
							<CheckCircle2 className="size-4" aria-hidden="true" />
						)}
						{loading ? "Streaming GPT-5.5 medium" : "Ready"}
					</span>
					{result ? (
						<>
							<span>· {result.model}</span>
							<span>· {result.cached ? "cached" : result.serviceTier}</span>
							<span>· {result.context.window.label}</span>
						</>
					) : null}
				</div>

				{result && actionCount > 0 ? (
					<div className="rounded-lg border border-[var(--line)] bg-[var(--bg-elevated)] px-3 py-2">
						<div className="mb-2 flex items-center gap-2 text-[13px] font-bold">
							<MessageSquare className="size-4" aria-hidden="true" />
							Action items
						</div>
						<ul className="flex flex-col gap-1 text-[14px] text-[var(--ink)]">
							{result.digest.actionItems.map((item, index) => (
								<li key={`${item.kind}:${item.label}:${String(index)}`}>
									<span className="font-semibold capitalize">{item.kind}</span>:{" "}
									{item.label}
								</li>
							))}
						</ul>
					</div>
				) : null}
			</section>

			{result ? <DigestOverview result={result} /> : null}

			{markdown ? (
				<MarkdownViewer
					context={result?.context ?? context}
					markdown={markdown}
				/>
			) : (
				<div className={statusCopyClass}>
					<span className="inline-flex items-center gap-2">
						{loading ? (
							<Sparkles className="size-4 animate-pulse" aria-hidden="true" />
						) : (
							<CalendarDays className="size-4" aria-hidden="true" />
						)}
						{loading ? "Waiting for the first tokens..." : "No digest yet."}
					</span>
				</div>
			)}
		</div>
	);
}
