import { createFileRoute } from "@tanstack/react-router";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";
import { AvatarChip } from "#/components/AvatarChip";
import { TweetRichText } from "#/components/TweetRichText";
import {
	cleanProfileHandle,
	formatProfileAnalysisCounts,
	ProfileAnalysisOutput,
	ProfileAnalysisStatusLine,
	useProfileAnalysisStream,
} from "#/components/ProfileAnalysisStream";
import { formatCompactNumber } from "#/lib/present";
import type { ProfileAnalysisContext } from "#/lib/profile-analysis";
import { profileDescriptionEntitiesFromXurl } from "#/lib/tweet-render";
import type { ProfileRecord, TweetEntities } from "#/lib/types";

export const Route = createFileRoute("/profiles/$handle")({
	component: ProfilesHandleRoute,
});

const profileHeaderButtonClass =
	"inline-flex items-center justify-center gap-1.5 rounded-full border border-[var(--line-strong)] bg-[var(--bg)] px-4 py-1.5 text-[14px] font-bold text-[var(--ink)] shadow-sm transition-colors duration-150 hover:bg-[var(--bg-hover)] disabled:cursor-default disabled:opacity-55";
const profileMentionRe = /(^|[^\w@./])@([A-Za-z0-9_]{1,15})\b/g;

function stableHue(value: string) {
	let hash = 0;
	for (const char of value) {
		hash = (hash * 31 + char.charCodeAt(0)) % 360;
	}
	return hash;
}

function ProfilesHandleRoute() {
	const { handle } = Route.useParams();
	return <ProfileRouteView handle={handle} />;
}

function profilesByHandleFromContext(context: ProfileAnalysisContext | null) {
	const profilesByHandle = new Map<string, ProfileRecord>();
	if (!context) return profilesByHandle;
	profilesByHandle.set(context.profile.handle.toLowerCase(), context.profile);
	for (const profile of context.profiles ?? []) {
		profilesByHandle.set(profile.handle.toLowerCase(), profile);
	}
	for (const tweet of context.conversations) {
		profilesByHandle.set(tweet.author.toLowerCase(), {
			id: tweet.profileId,
			handle: tweet.author,
			displayName: tweet.name || tweet.author,
			bio: tweet.bio,
			followersCount: tweet.followersCount,
			avatarHue: 210,
			avatarUrl: tweet.avatarUrl,
			createdAt: tweet.createdAt,
		});
	}
	return profilesByHandle;
}

function profileBioEntities(
	profile: ProfileRecord,
	profilesByHandle: Map<string, ProfileRecord>,
) {
	const entities = profileDescriptionEntitiesFromXurl(profile.entities);
	const mentions = entities.mentions ?? [];
	const existingMentionRanges = new Set(
		mentions.map((mention) => `${mention.start}:${mention.end}`),
	);
	for (const match of profile.bio.matchAll(profileMentionRe)) {
		const start = (match.index ?? 0) + match[1].length;
		const username = match[2];
		const end = start + username.length + 1;
		const key = `${start}:${end}`;
		if (existingMentionRanges.has(key)) continue;
		const linkedProfile = profilesByHandle.get(username.toLowerCase());
		mentions.push({
			username,
			start,
			end,
			...(linkedProfile ? { profile: linkedProfile } : {}),
		});
	}
	const next: TweetEntities = {
		...entities,
		...(mentions.length ? { mentions } : {}),
	};
	return next;
}

function ProfileBioText({
	profile,
	profilesByHandle,
}: {
	profile: ProfileRecord;
	profilesByHandle: Map<string, ProfileRecord>;
}) {
	return (
		<TweetRichText
			className="m-0 max-w-2xl whitespace-pre-wrap text-[15px] leading-[1.45] text-[var(--ink)] [overflow-wrap:anywhere]"
			entities={profileBioEntities(profile, profilesByHandle)}
			text={profile.bio}
			urlLabel="expanded"
		/>
	);
}

export function ProfileRouteView({ handle }: { handle: string }) {
	const cleanHandle = cleanProfileHandle(handle);
	const analysis = useProfileAnalysisStream(cleanHandle);
	const autoRunHandleRef = useRef("");
	const runAnalysisRef = useRef(analysis.run);
	const profile = analysis.context?.profile;
	const displayName = profile?.displayName || `@${cleanHandle}`;
	const bio = profile?.bio ?? "";
	const profilesByHandle = profilesByHandleFromContext(analysis.context);

	useEffect(() => {
		runAnalysisRef.current = analysis.run;
	}, [analysis.run]);

	useEffect(() => {
		if (cleanHandle && autoRunHandleRef.current !== cleanHandle) {
			autoRunHandleRef.current = cleanHandle;
			runAnalysisRef.current(false, cleanHandle);
		}
	}, [cleanHandle]);

	return (
		<section className="flex min-h-screen flex-col">
			<header className="border-b border-[var(--line)] bg-[var(--bg)]">
				<div
					className="h-32 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--bg-active)_68%,var(--accent)_32%),color-mix(in_srgb,var(--bg)_70%,var(--accent)_30%))]"
					data-testid="profile-cover"
				/>
				<div className="px-4 pb-5">
					<div className="flex flex-col gap-4">
						<div
							className="-mt-8 flex items-start justify-between gap-3"
							data-testid="profile-avatar-overlap"
						>
							<div className="flex min-w-0 items-start gap-3">
								<span className="inline-grid rounded-full ring-4 ring-[var(--bg)]">
									<AvatarChip
										avatarUrl={profile?.avatarUrl ?? undefined}
										hue={profile?.avatarHue ?? stableHue(cleanHandle)}
										name={displayName}
										profileId={profile?.id}
										size="large"
									/>
								</span>
								<div className="min-w-0 pb-1 pt-9">
									<h1 className="m-0 truncate text-[24px] font-bold text-[var(--ink)]">
										{displayName}
									</h1>
									<div className="truncate text-[14px] text-[var(--ink-soft)]">
										@{profile?.handle ?? cleanHandle}
									</div>
								</div>
							</div>
							<div className="mt-10 flex shrink-0 items-center gap-2">
								<a
									className={profileHeaderButtonClass}
									href={`https://x.com/${encodeURIComponent(profile?.handle ?? cleanHandle)}`}
									rel="noreferrer"
									target="_blank"
								>
									<ExternalLink className="size-4" strokeWidth={1.8} />X
								</a>
								<button
									className={profileHeaderButtonClass}
									disabled={!cleanHandle || analysis.loading}
									onClick={() => analysis.run(true, cleanHandle)}
									type="button"
								>
									{analysis.loading ? (
										<Loader2
											className="size-4 animate-spin"
											strokeWidth={1.8}
										/>
									) : (
										<RefreshCw className="size-4" strokeWidth={1.8} />
									)}
									Refresh
								</button>
							</div>
						</div>

						{profile && bio ? (
							<ProfileBioText
								profile={profile}
								profilesByHandle={profilesByHandle}
							/>
						) : null}

						<div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-[var(--ink-soft)]">
							{profile ? (
								<>
									<span>
										<strong className="text-[var(--ink)]">
											{formatCompactNumber(profile.followersCount)}
										</strong>{" "}
										followers
									</span>
									<span>
										<strong className="text-[var(--ink)]">
											{formatCompactNumber(profile.followingCount ?? 0)}
										</strong>{" "}
										following
									</span>
								</>
							) : null}
							<span>{formatProfileAnalysisCounts(analysis.context)}</span>
						</div>
					</div>
				</div>
			</header>

			<div className="flex flex-col gap-5 px-4 py-5">
				<ProfileAnalysisStatusLine analysis={analysis} />
				<ProfileAnalysisOutput
					analysis={analysis}
					emptyLabel={`Preparing @${cleanHandle}.`}
				/>
			</div>
		</section>
	);
}
