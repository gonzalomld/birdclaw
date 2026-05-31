import { CheckCircle2, Loader2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MarkdownViewer } from "#/components/MarkdownViewer";
import type {
	ProfileAnalysisContext,
	ProfileAnalysisRunResult,
	ProfileAnalysisStreamEvent,
} from "#/lib/profile-analysis";
import type { ProfileRecord } from "#/lib/types";
import { errorCopyClass } from "#/lib/ui";

export interface ProfileAnalysisRequestOptions {
	refresh: boolean;
	maxTweets: number;
	maxPages: number;
	maxConversations: number;
	maxConversationPages: number;
}

export interface ProfileAnalysisState {
	context: ProfileAnalysisContext | null;
	error: string | null;
	loading: boolean;
	markdown: string;
	result: ProfileAnalysisRunResult | null;
	run: (refresh?: boolean, overrideHandle?: string) => void;
	status: string;
}

export const DEFAULT_PROFILE_ANALYSIS_LIMITS = {
	maxTweets: 10000,
	maxPages: 100,
	maxConversations: 80,
	maxConversationPages: 3,
} as const;

const PROFILE_HYDRATION_LIMIT = 50;
const PROFILE_MENTION_RE = /(^|[^\w@./])@([A-Za-z0-9_]{1,15})\b/g;

function normalizeProfileHandle(value: string) {
	return value.trim().replace(/^@/, "").toLowerCase();
}

function handlesFromText(value: string) {
	return Array.from(value.matchAll(PROFILE_MENTION_RE)).map(
		(match) => match[2],
	);
}

function knownProfileHandles(context: ProfileAnalysisContext) {
	const handles = new Set<string>();
	handles.add(normalizeProfileHandle(context.profile.handle));
	for (const profile of context.profiles ?? []) {
		handles.add(normalizeProfileHandle(profile.handle));
	}
	for (const tweet of context.conversations) {
		handles.add(normalizeProfileHandle(tweet.author));
	}
	return handles;
}

function collectProfileAnalysisHydrationHandles(
	result: ProfileAnalysisRunResult,
) {
	const handles = new Set<string>();
	const known = knownProfileHandles(result.context);
	const add = (value: string | undefined) => {
		if (!value) return;
		const handle = normalizeProfileHandle(value);
		if (!/^[a-z0-9_]{1,15}$/.test(handle) || known.has(handle)) return;
		handles.add(handle);
	};

	for (const handle of result.analysis.sourceHandles) add(handle);
	for (const theme of result.analysis.themes) {
		for (const handle of theme.handles) add(handle);
	}
	for (const handle of handlesFromText(result.markdown)) add(handle);
	for (const handle of handlesFromText(result.context.profile.bio)) add(handle);
	for (const tweet of result.context.tweets) {
		for (const handle of handlesFromText(tweet.text)) add(handle);
	}
	for (const tweet of result.context.conversations) {
		for (const handle of handlesFromText(tweet.text)) add(handle);
		for (const handle of handlesFromText(tweet.bio)) add(handle);
	}

	return [...handles].slice(0, PROFILE_HYDRATION_LIMIT);
}

function applyHydratedProfilesToProfileAnalysisContext(
	context: ProfileAnalysisContext,
	profiles: ProfileRecord[],
) {
	const existing = new Map<string, ProfileRecord>();
	for (const profile of context.profiles ?? []) {
		existing.set(normalizeProfileHandle(profile.handle), profile);
	}
	for (const profile of profiles) {
		existing.set(normalizeProfileHandle(profile.handle), profile);
	}
	return {
		...context,
		profiles: [...existing.values()],
	};
}

async function hydrateProfileAnalysisContext(result: ProfileAnalysisRunResult) {
	const handles = collectProfileAnalysisHydrationHandles(result);
	if (handles.length === 0) return result.context;
	const url = new URL("/api/profile-hydrate", window.location.origin);
	url.searchParams.set("handles", handles.join(","));
	const response = await fetch(url);
	if (!response.ok) return result.context;
	const payload = (await response.json()) as {
		results?: Array<{ status?: string; profile?: ProfileRecord }>;
	};
	const profiles = (payload.results ?? [])
		.filter((item) => item.status === "hit" && item.profile)
		.map((item) => item.profile as ProfileRecord);
	return profiles.length > 0
		? applyHydratedProfilesToProfileAnalysisContext(result.context, profiles)
		: result.context;
}

export function profileAnalysisUrl(
	handle: string,
	options: ProfileAnalysisRequestOptions,
) {
	const params = new URLSearchParams();
	params.set("handle", handle);
	params.set("maxTweets", String(options.maxTweets));
	params.set("maxPages", String(options.maxPages));
	params.set("maxConversations", String(options.maxConversations));
	params.set("maxConversationPages", String(options.maxConversationPages));
	if (options.refresh) {
		params.set("refresh", "true");
	}
	return `/api/profile-analysis?${params.toString()}`;
}

export async function profileAnalysisRequestError(response: Response) {
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
			? `Profile analysis failed (${status}): ${detail}`
			: `Profile analysis failed (${status})`,
	);
}

export function formatProfileAnalysisCounts(
	context: ProfileAnalysisContext | null,
) {
	if (!context) return "xurl profile backfill with cached AI analysis.";
	return [
		context.fetchCached ? "cached backfill" : "fresh xurl backfill",
		`${String(context.counts.tweets)} tweets`,
		`${String(context.counts.conversationTweets)} conversation tweets`,
		`${String(context.counts.conversationsScanned)} conversations`,
	].join(" · ");
}

export function cleanProfileHandle(value: string) {
	return value.trim().replace(/^@/, "");
}

export function useProfileAnalysisStream(handle: string): ProfileAnalysisState {
	const [markdown, setMarkdown] = useState("");
	const [context, setContext] = useState<ProfileAnalysisContext | null>(null);
	const [result, setResult] = useState<ProfileAnalysisRunResult | null>(null);
	const [status, setStatus] = useState("Ready");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const abortRef = useRef<AbortController | null>(null);
	const requestIdRef = useRef(0);

	const run = useCallback(
		(refresh = false, overrideHandle?: string) => {
			const trimmed = cleanProfileHandle(overrideHandle ?? handle);
			if (!trimmed) return;
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
			setStatus("Starting profile analysis");

			fetch(
				profileAnalysisUrl(trimmed, {
					refresh,
					...DEFAULT_PROFILE_ANALYSIS_LIMITS,
				}),
				{ signal: controller.signal },
			)
				.then(async (response) => {
					if (!response.ok) {
						throw await profileAnalysisRequestError(response);
					}
					if (!response.body) {
						throw new Error("Profile analysis failed: empty response body");
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
									const event = JSON.parse(line) as ProfileAnalysisStreamEvent;
									if (!isActiveRequest()) return;
									if (event.type === "status") {
										setStatus(
											event.detail
												? `${event.label} · ${event.detail}`
												: event.label,
										);
									} else if (event.type === "start") {
										setContext(event.context);
										setStatus(
											event.cached
												? "Loading cached analysis"
												: "Summarizing profile",
										);
									} else if (event.type === "delta") {
										setMarkdown((current) => current + event.delta);
									} else if (event.type === "done") {
										setResult(event.result);
										setContext(event.result.context);
										setMarkdown(event.result.markdown);
										setStatus(event.result.cached ? "Cached" : "Complete");
										void hydrateProfileAnalysisContext(event.result)
											.then((hydratedContext) => {
												if (!isActiveRequest()) return;
												if (hydratedContext === event.result.context) return;
												setContext(hydratedContext);
												setResult({
													...event.result,
													context: hydratedContext,
												});
											})
											.catch(() => {
												// Profile hover hydration is best-effort; analysis remains usable.
											});
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
					setError(cause instanceof Error ? cause.message : "Analysis failed");
				})
				.finally(() => {
					if (!isActiveRequest()) return;
					setLoading(false);
				});
		},
		[handle],
	);

	useEffect(
		() => () => {
			abortRef.current?.abort();
		},
		[],
	);

	return { context, error, loading, markdown, result, run, status };
}

export function ProfileAnalysisStatusLine({
	analysis,
	className = "",
}: {
	analysis: ProfileAnalysisState;
	className?: string;
}) {
	return (
		<div
			className={`flex items-center gap-2 text-[13px] font-medium text-[var(--ink-soft)] ${className}`}
		>
			{analysis.loading ? (
				<Loader2 className="size-4 animate-spin" strokeWidth={1.8} />
			) : analysis.result ? (
				<CheckCircle2 className="size-4" strokeWidth={1.8} />
			) : (
				<Sparkles className="size-4" strokeWidth={1.8} />
			)}
			<span>{analysis.status}</span>
		</div>
	);
}

export function ProfileAnalysisOutput({
	analysis,
	emptyLabel = "No profile selected.",
}: {
	analysis: ProfileAnalysisState;
	emptyLabel?: string;
}) {
	return (
		<>
			{analysis.error ? (
				<div className={errorCopyClass}>{analysis.error}</div>
			) : null}

			{analysis.markdown ? (
				<div className="max-w-3xl">
					<MarkdownViewer
						context={analysis.context}
						markdown={analysis.markdown}
					/>
				</div>
			) : (
				<div className="rounded-[8px] border border-[var(--line)] bg-[var(--panel)] p-6 text-[14px] text-[var(--ink-soft)]">
					{emptyLabel}
				</div>
			)}
		</>
	);
}
