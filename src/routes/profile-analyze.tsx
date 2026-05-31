import { createFileRoute } from "@tanstack/react-router";
import {
	CheckCircle2,
	Loader2,
	RefreshCw,
	Search,
	Sparkles,
	UserSearch,
} from "lucide-react";
import {
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { MarkdownViewer } from "#/components/MarkdownViewer";
import type {
	ProfileAnalysisContext,
	ProfileAnalysisRunResult,
	ProfileAnalysisStreamEvent,
} from "#/lib/profile-analysis";
import {
	cx,
	errorCopyClass,
	pageHeaderActionsClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	primaryButtonClass,
	searchFieldIconClass,
	searchFieldInputClass,
	searchFieldShellClass,
	secondaryButtonClass,
} from "#/lib/ui";

export const Route = createFileRoute("/profile-analyze")({
	component: ProfileAnalyzeRoute,
	validateSearch: (search: Record<string, unknown>) => ({
		handle: typeof search.handle === "string" ? search.handle : "",
	}),
});

function analysisUrl(
	handle: string,
	options: {
		refresh: boolean;
		maxTweets: number;
		maxPages: number;
		maxConversations: number;
		maxConversationPages: number;
	},
) {
	const url = new URL("/api/profile-analysis", window.location.origin);
	url.searchParams.set("handle", handle);
	url.searchParams.set("maxTweets", String(options.maxTweets));
	url.searchParams.set("maxPages", String(options.maxPages));
	url.searchParams.set("maxConversations", String(options.maxConversations));
	url.searchParams.set(
		"maxConversationPages",
		String(options.maxConversationPages),
	);
	if (options.refresh) {
		url.searchParams.set("refresh", "true");
	}
	return url;
}

async function analysisRequestError(response: Response) {
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

function formatCounts(context: ProfileAnalysisContext | null) {
	if (!context) return "xurl profile backfill with cached AI analysis.";
	return [
		context.fetchCached ? "cached backfill" : "fresh xurl backfill",
		`${String(context.counts.tweets)} tweets`,
		`${String(context.counts.conversationTweets)} conversation tweets`,
		`${String(context.counts.conversationsScanned)} conversations`,
	].join(" · ");
}

function cleanHandle(value: string) {
	return value.trim().replace(/^@/, "");
}

function useProfileAnalysisStream(handle: string) {
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
			const trimmed = cleanHandle(overrideHandle ?? handle);
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
				analysisUrl(trimmed, {
					refresh,
					maxTweets: 10000,
					maxPages: 100,
					maxConversations: 80,
					maxConversationPages: 3,
				}),
				{ signal: controller.signal },
			)
				.then(async (response) => {
					if (!response.ok) {
						throw await analysisRequestError(response);
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

function ProfileAnalyzeRoute() {
	const search = Route.useSearch();
	const [handle, setHandle] = useState(cleanHandle(search.handle));
	const submittedHandle = useMemo(() => cleanHandle(handle), [handle]);
	const analysis = useProfileAnalysisStream(submittedHandle);
	const autoRunHandleRef = useRef("");
	const runAnalysisRef = useRef(analysis.run);

	useEffect(() => {
		runAnalysisRef.current = analysis.run;
	}, [analysis.run]);

	useEffect(() => {
		const urlHandle = cleanHandle(search.handle);
		setHandle(urlHandle);
		if (urlHandle && autoRunHandleRef.current !== urlHandle) {
			autoRunHandleRef.current = urlHandle;
			runAnalysisRef.current(false, urlHandle);
		}
	}, [search.handle]);

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		analysis.run(false);
	};

	return (
		<section className="flex min-h-screen flex-col gap-6 px-4 py-8">
			<header className={cx(pageHeaderClass, "border-b-0")}>
				<div className={pageHeaderRowClass}>
					<div>
						<h1 className={pageTitleClass}>Profile Analyse</h1>
						<p className={pageSubtitleClass}>
							{formatCounts(analysis.context)}
						</p>
					</div>
					<div className={pageHeaderActionsClass}>
						<button
							className={secondaryButtonClass}
							disabled={!submittedHandle || analysis.loading}
							onClick={() => analysis.run(true)}
							type="button"
						>
							<RefreshCw className="size-4" strokeWidth={1.8} />
							Refresh
						</button>
					</div>
				</div>
				<form
					className="mt-5 flex flex-col gap-3 sm:flex-row"
					onSubmit={submit}
				>
					<label className={cx(searchFieldShellClass, "min-w-0 flex-1")}>
						<Search className={searchFieldIconClass} strokeWidth={1.8} />
						<input
							className={searchFieldInputClass}
							onChange={(event) => setHandle(event.target.value)}
							placeholder="handle"
							value={handle}
						/>
					</label>
					<button
						className={primaryButtonClass}
						disabled={!submittedHandle || analysis.loading}
						type="submit"
					>
						{analysis.loading ? (
							<Loader2 className="size-4 animate-spin" strokeWidth={1.8} />
						) : (
							<UserSearch className="size-4" strokeWidth={1.8} />
						)}
						Analyse
					</button>
				</form>
			</header>

			<div className="flex items-center gap-2 text-[13px] font-medium text-[var(--ink-soft)]">
				{analysis.loading ? (
					<Loader2 className="size-4 animate-spin" strokeWidth={1.8} />
				) : analysis.result ? (
					<CheckCircle2 className="size-4" strokeWidth={1.8} />
				) : (
					<Sparkles className="size-4" strokeWidth={1.8} />
				)}
				<span>{analysis.status}</span>
			</div>

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
					No profile selected.
				</div>
			)}
		</section>
	);
}
