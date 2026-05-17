import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Effect } from "effect";
import { getNativeDb } from "./db";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import type { Database } from "./sqlite";
import {
	normalizeUrlExpansionForIndex,
	upsertUrlExpansion,
} from "./url-expansion-store";

const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_CHARS = 2_000_000;
const MAX_REDIRECTS = 4;
const NO_BODY_STATUS_CODES = new Set([204, 205, 304]);
const PRIVATE_IPV4_RANGES = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] satisfies Array<[string, number]>;

export interface LinkPreviewMetadata {
	url: string;
	title: string | null;
	description: string | null;
	imageUrl: string | null;
	siteName: string | null;
	error?: string | null;
}

export interface GetLinkPreviewOptions {
	shortUrl?: string | null;
	refresh?: boolean;
	fetchImpl?: typeof fetch;
	resolveHost?: (hostname: string) => Promise<string[]>;
	timeoutMs?: number;
}

interface ResolvedAddress {
	address: string;
	family: 4 | 6;
}

type UrlExpansionPreviewRow = {
	short_url: string;
	expanded_url: string;
	final_url: string;
	status: "hit" | "miss" | "error";
	title: string | null;
	description: string | null;
	image_url: string | null;
	site_name: string | null;
	error: string | null;
	source: string;
	updated_at: string;
};

function cleanText(value: string | null | undefined) {
	if (!value) return null;
	const cleaned = decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
	return cleaned.length > 0 ? cleaned : null;
}

function decodeCodePoint(value: number, fallback: string) {
	try {
		return String.fromCodePoint(value);
	} catch {
		return fallback;
	}
}

function decodeHtmlEntities(value: string) {
	return value
		.replace(/&#(\d+);/g, (entity: string, code: string) =>
			decodeCodePoint(Number(code), entity),
		)
		.replace(/&#x([a-f0-9]+);/gi, (entity: string, code: string) =>
			decodeCodePoint(Number.parseInt(code, 16), entity),
		)
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'");
}

function parseAttributes(tag: string) {
	const attributes = new Map<string, string>();
	for (const match of tag.matchAll(
		/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
	)) {
		const key = match[1]?.toLowerCase();
		const value = match[3] ?? match[4] ?? match[5] ?? "";
		if (key) {
			attributes.set(key, value);
		}
	}
	return attributes;
}

function metaContents(html: string) {
	const values = new Map<string, string>();
	for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
		const attributes = parseAttributes(match[0]);
		const key = (
			attributes.get("property") ??
			attributes.get("name") ??
			""
		).toLowerCase();
		const content = cleanText(
			attributes.get("content") ?? attributes.get("value") ?? "",
		);
		if (key && content && !values.has(key)) {
			values.set(key, content);
		}
	}
	return values;
}

function pick(values: Map<string, string>, keys: string[]) {
	for (const key of keys) {
		const value = cleanText(values.get(key));
		if (value) return value;
	}
	return null;
}

function titleFromHtml(html: string) {
	const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
	return cleanText(match?.[1]);
}

function absoluteUrl(value: string | null, baseUrl: string) {
	if (!value) return null;
	try {
		return new URL(value, baseUrl).toString();
	} catch {
		return null;
	}
}

function hostLabel(url: string) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function ipv4ToNumber(value: string) {
	const parts = value.split(".").map((part) => Number(part));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
		return null;
	}
	if (parts.some((part) => part < 0 || part > 255)) return null;
	return (
		(parts[0] ?? 0) * 256 ** 3 +
		(parts[1] ?? 0) * 256 ** 2 +
		(parts[2] ?? 0) * 256 +
		(parts[3] ?? 0)
	);
}

function isIpv4InRange(address: string, range: string, prefix: number) {
	const addressNumber = ipv4ToNumber(address);
	const rangeNumber = ipv4ToNumber(range);
	if (addressNumber === null || rangeNumber === null) return false;
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return (addressNumber & mask) === (rangeNumber & mask);
}

function isPrivateIpv4(address: string) {
	return PRIVATE_IPV4_RANGES.some(([range, prefix]) =>
		isIpv4InRange(address, range, prefix),
	);
}

function normalizeIpv6(address: string) {
	return address.toLowerCase().replace(/^\[|\]$/g, "");
}

function parseIpv6Parts(address: string) {
	let normalized = normalizeIpv6(address);
	if (net.isIP(normalized) !== 6) return null;

	if (normalized.includes(".")) {
		const lastColon = normalized.lastIndexOf(":");
		const ipv4 = normalized.slice(lastColon + 1);
		const addressNumber = ipv4ToNumber(ipv4);
		if (addressNumber === null) return null;
		normalized = `${normalized.slice(0, lastColon + 1)}${(
			(addressNumber >>> 16) &
			0xffff
		).toString(16)}:${(addressNumber & 0xffff).toString(16)}`;
	}

	const halves = normalized.split("::");
	if (halves.length > 2) return null;
	const parseGroups = (value: string) =>
		value === ""
			? []
			: value.split(":").map((part) => Number.parseInt(part, 16));
	const left = parseGroups(halves[0] ?? "");
	const right = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
	const missingGroups = 8 - left.length - right.length;
	if (
		(halves.length === 1 && missingGroups !== 0) ||
		(halves.length === 2 && missingGroups < 0) ||
		![...left, ...right].every(
			(part) => Number.isInteger(part) && part >= 0 && part <= 0xffff,
		)
	) {
		return null;
	}
	return [...left, ...Array.from({ length: missingGroups }, () => 0), ...right];
}

function ipv4FromHexPair(parts: string[]) {
	if (parts.length !== 2) return null;
	const high = Number.parseInt(parts[0] ?? "", 16);
	const low = Number.parseInt(parts[1] ?? "", 16);
	if (
		![high, low].every(
			(part) => Number.isInteger(part) && part >= 0 && part <= 0xffff,
		)
	) {
		return null;
	}
	return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join(".");
}

function ipv4FromIpv6Parts(parts: number[]) {
	const tailIpv4 = () =>
		[
			(parts[6] >> 8) & 255,
			parts[6] & 255,
			(parts[7] >> 8) & 255,
			parts[7] & 255,
		].join(".");
	const hasZeroPrefix = (length: number) =>
		parts.slice(0, length).every((part) => part === 0);
	if (hasZeroPrefix(5) && parts[5] === 0xffff) return tailIpv4();
	if (hasZeroPrefix(4) && parts[4] === 0xffff && parts[5] === 0) {
		return tailIpv4();
	}
	if (hasZeroPrefix(6)) return tailIpv4();
	if (parts[0] === 0x64 && parts[1] === 0xff9b && parts[2] === 0) {
		return tailIpv4();
	}
	if (parts[0] === 0x64 && parts[1] === 0xff9b && parts[2] === 1) {
		return tailIpv4();
	}
	if (parts[0] === 0x2002) {
		return [
			(parts[1] >> 8) & 255,
			parts[1] & 255,
			(parts[2] >> 8) & 255,
			parts[2] & 255,
		].join(".");
	}
	return null;
}

function ipv4FromIpv6Suffix(address: string) {
	const normalized = normalizeIpv6(address);
	const parts = parseIpv6Parts(normalized);
	if (parts) return ipv4FromIpv6Parts(parts);
	const prefix = ["::ffff:", "64:ff9b::", "64:ff9b:1::", "::"].find((value) =>
		normalized.startsWith(value),
	);
	if (!prefix) return null;
	const suffix = normalized.slice(prefix.length);
	if (net.isIP(suffix) === 4) return suffix;
	return ipv4FromHexPair(suffix.split(":"));
}

function isPrivateIpv6(address: string) {
	const normalized = normalizeIpv6(address);
	const parts = parseIpv6Parts(normalized);
	const mappedIpv4 = parts
		? ipv4FromIpv6Parts(parts)
		: ipv4FromIpv6Suffix(normalized);
	if (mappedIpv4) return isPrivateIpv4(mappedIpv4);
	if (parts) {
		const first = parts[0] ?? 0;
		return (
			parts.every((part) => part === 0) ||
			parts.slice(0, 7).every((part) => part === 0) ||
			(first & 0xfe00) === 0xfc00 ||
			(first & 0xffc0) === 0xfe80 ||
			(first & 0xffc0) === 0xfec0 ||
			(first & 0xff00) === 0xff00
		);
	}
	return (
		normalized === "::" ||
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		normalized.startsWith("fe8") ||
		normalized.startsWith("fe9") ||
		normalized.startsWith("fea") ||
		normalized.startsWith("feb") ||
		normalized.startsWith("ff")
	);
}

function isBlockedAddress(address: string) {
	const normalized = address.replace(/^\[|\]$/g, "");
	const family = net.isIP(normalized);
	if (family === 4) return isPrivateIpv4(normalized);
	if (family === 6) return isPrivateIpv6(normalized);
	return false;
}

function isLocalHostname(hostname: string) {
	const normalized = hostname.toLowerCase().replace(/\.$/, "");
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized.endsWith(".local") ||
		normalized.endsWith(".internal") ||
		normalized.endsWith(".test")
	);
}

function assertSafePreviewUrl(url: string) {
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Link preview URL must use http or https");
	}
	if (parsed.username || parsed.password) {
		throw new Error("Link preview URL must not include credentials");
	}
	if (isLocalHostname(parsed.hostname) || isBlockedAddress(parsed.hostname)) {
		throw new Error("Link preview URL points to a private host");
	}
	return parsed;
}

function isInjectedFetchAllowed() {
	return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function stripAddressBrackets(value: string) {
	return value.replace(/^\[|\]$/g, "");
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
	let timer: NodeJS.Timeout | null = null;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error("Link preview request timed out")),
			ms,
		);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

async function resolvePublicAddresses(hostname: string): Promise<string[]> {
	const normalized = stripAddressBrackets(hostname);
	if (net.isIP(normalized)) return [normalized];
	const records = await lookup(normalized, { all: true, verbatim: true });
	return records.map((record) => record.address);
}

function validateResolvedAddresses(addresses: string[]) {
	if (addresses.length === 0) {
		throw new Error("Link preview host did not resolve");
	}
	if (addresses.some(isBlockedAddress)) {
		throw new Error("Link preview URL resolves to a private address");
	}
}

async function resolveSafeAddresses(
	hostname: string,
	resolveHost: (hostname: string) => Promise<string[]>,
	timeoutMs: number,
): Promise<ResolvedAddress[]> {
	const normalizedHostname = stripAddressBrackets(hostname);
	const addresses = await withTimeout(
		resolveHost(normalizedHostname),
		timeoutMs,
	);
	validateResolvedAddresses(addresses);
	return addresses.map((address) => {
		const normalized = stripAddressBrackets(address);
		const family = net.isIP(normalized);
		if (family !== 4 && family !== 6) {
			throw new Error("Link preview host resolved to an invalid address");
		}
		return { address: normalized, family };
	});
}

function headersFromIncoming(headers: http.IncomingHttpHeaders): HeadersInit {
	const result = new Headers();
	for (const [key, value] of Object.entries(headers)) {
		if (Array.isArray(value)) {
			for (const item of value) result.append(key, item);
		} else if (typeof value === "string") {
			result.set(key, value);
		}
	}
	return result;
}

function decodedResponseBody(response: Response) {
	const body = response.body;
	if (!body) return null;
	const encoding = response.headers
		.get("content-encoding")
		?.split(",")
		.at(-1)
		?.trim()
		.toLowerCase();
	if (!encoding || encoding === "identity") return body;
	const nodeBody = Readable.fromWeb(
		body as Parameters<typeof Readable.fromWeb>[0],
	);
	if (encoding === "gzip" || encoding === "x-gzip") {
		return Readable.toWeb(nodeBody.pipe(createGunzip())) as ReadableStream;
	}
	if (encoding === "br") {
		return Readable.toWeb(
			nodeBody.pipe(createBrotliDecompress()),
		) as ReadableStream;
	}
	if (encoding === "deflate") {
		return Readable.toWeb(nodeBody.pipe(createInflate())) as ReadableStream;
	}
	return body;
}

function respondWithResolvedAddress(
	selected: ResolvedAddress,
	lookupOptions: { all?: boolean } | number | undefined,
	callback: (
		error: Error | null,
		address: string | ResolvedAddress[],
		family?: 4 | 6,
	) => void,
) {
	if (typeof lookupOptions === "object" && lookupOptions?.all) {
		callback(null, [selected]);
		return;
	}
	callback(null, selected.address, selected.family);
}

function nodeSafeFetch(
	url: URL,
	options: {
		addresses: ResolvedAddress[];
		headers: Record<string, string>;
		timeoutMs: number;
	},
) {
	const deadline = Date.now() + options.timeoutMs;

	function fetchAddress(address: ResolvedAddress, attemptTimeoutMs: number) {
		return new Promise<Response>((resolve, reject) => {
			let settled = false;
			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				try {
					callback();
				} catch (error) {
					reject(error);
				}
			};

			const client = url.protocol === "https:" ? https : http;
			let wallClockTimeout: NodeJS.Timeout | null = null;
			const clearWallClockTimeout = () => {
				if (!wallClockTimeout) return;
				clearTimeout(wallClockTimeout);
				wallClockTimeout = null;
			};
			const setWallClockTimeout = (
				ms: number,
				target: { destroy: (error: Error) => void },
			) => {
				clearWallClockTimeout();
				wallClockTimeout = setTimeout(() => {
					target.destroy(new Error("Link preview request timed out"));
				}, ms);
			};
			const request = client.request(
				url,
				{
					headers: options.headers,
					lookup: (_hostname, lookupOptions, callback) => {
						respondWithResolvedAddress(address, lookupOptions, callback);
					},
				},
				(incoming) => {
					request.setTimeout(0);
					setWallClockTimeout(Math.max(1, deadline - Date.now()), incoming);
					incoming.once("end", clearWallClockTimeout);
					incoming.once("close", clearWallClockTimeout);
					incoming.once("error", clearWallClockTimeout);
					finish(() => {
						const status = incoming.statusCode ?? 200;
						const response = new Response(
							NO_BODY_STATUS_CODES.has(status)
								? null
								: (Readable.toWeb(incoming) as ReadableStream),
							{
								headers: headersFromIncoming(incoming.headers),
								status,
								statusText: incoming.statusMessage,
							},
						);
						Object.defineProperty(response, "url", {
							value: url.toString(),
						});
						resolve(response);
					});
				},
			);
			setWallClockTimeout(attemptTimeoutMs, request);
			request.setTimeout(attemptTimeoutMs, () => {
				request.destroy(new Error("Link preview request timed out"));
			});
			request.on("error", (error) => {
				clearWallClockTimeout();
				finish(() => reject(error));
			});
			request.end();
		});
	}

	return options.addresses.reduce<Promise<Response>>(
		(previous, address, index) =>
			previous.catch((error: unknown) => {
				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0) throw error;
				const remainingAddresses = options.addresses.length - index;
				const attemptTimeoutMs = Math.max(
					1,
					Math.ceil(remainingMs / remainingAddresses),
				);
				return fetchAddress(address, attemptTimeoutMs);
			}),
		Promise.reject(new Error("Link preview host did not resolve")),
	);
}

function safePreviewFetchEffect(
	url: string,
	options: Pick<
		GetLinkPreviewOptions,
		"fetchImpl" | "resolveHost" | "timeoutMs"
	>,
) {
	const resolveHost =
		options.resolveHost ??
		(options.fetchImpl
			? null
			: (hostname: string) => resolvePublicAddresses(hostname));
	const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;
	const remainingTimeoutMs = () => Math.max(1, deadline - Date.now());
	const headers: Record<string, string> = {
		"user-agent":
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 birdclaw/0.4",
		accept:
			"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
		"accept-language": "en-US,en;q=0.9",
	};

	return Effect.gen(function* () {
		if (options.fetchImpl && !isInjectedFetchAllowed()) {
			return yield* Effect.fail(
				new Error("Custom link preview fetch is only available in tests"),
			);
		}

		let currentUrl = url;
		for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
			if (Date.now() >= deadline) {
				return yield* Effect.fail(new Error("Link preview request timed out"));
			}
			let remainingMs = remainingTimeoutMs();
			const parsed = yield* Effect.try({
				try: () => assertSafePreviewUrl(currentUrl),
				catch: (error) => error,
			});
			if (options.fetchImpl && resolveHost) {
				yield* tryPromise(() =>
					resolveSafeAddresses(parsed.hostname, resolveHost, remainingMs),
				);
			}
			if (Date.now() >= deadline) {
				return yield* Effect.fail(new Error("Link preview request timed out"));
			}
			remainingMs = remainingTimeoutMs();

			const response = options.fetchImpl
				? yield* tryPromise(
						() =>
							options.fetchImpl?.(parsed.toString(), {
								headers,
								redirect: "manual",
								signal: AbortSignal.timeout(remainingMs),
							}) as Promise<Response>,
					)
				: yield* tryPromise(() =>
						resolveSafeAddresses(
							parsed.hostname,
							options.resolveHost ?? resolvePublicAddresses,
							remainingMs,
						).then((addresses) =>
							Date.now() >= deadline
								? Promise.reject(new Error("Link preview request timed out"))
								: nodeSafeFetch(parsed, {
										addresses,
										headers,
										timeoutMs: remainingTimeoutMs(),
									}),
						),
					);
			if (response.status < 300 || response.status >= 400) return response;

			const location = response.headers.get("location");
			if (!location) return response;
			yield* tryPromise(
				() => response.body?.cancel() ?? Promise.resolve(),
			).pipe(Effect.catchAll(() => Effect.void));
			if (redirect === MAX_REDIRECTS) {
				return yield* Effect.fail(
					new Error("Link preview redirected too many times"),
				);
			}
			const nextUrl = yield* Effect.try({
				try: () => new URL(location, parsed).toString(),
				catch: (error) => error,
			});
			currentUrl = nextUrl;
		}
		return yield* Effect.fail(
			new Error("Link preview redirected too many times"),
		);
	});
}

function readResponseTextEffect(response: Response) {
	const contentLength = Number(response.headers.get("content-length") ?? 0);
	if (Number.isFinite(contentLength) && contentLength > MAX_HTML_CHARS) {
		return tryPromise(() => response.body?.cancel() ?? Promise.resolve()).pipe(
			Effect.flatMap(() =>
				Effect.fail(new Error("Link preview response is too large")),
			),
		);
	}
	const reader = decodedResponseBody(response)?.getReader();
	if (!reader) return tryPromise(() => response.text());
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	return Effect.gen(function* () {
		for (;;) {
			const { done, value } = yield* tryPromise(() => reader.read());
			if (done) break;
			total += value.byteLength;
			if (total > MAX_HTML_CHARS) {
				yield* tryPromise(() =>
					reader.cancel(new Error("Link preview response is too large")),
				);
				return yield* Effect.fail(
					new Error("Link preview response is too large"),
				);
			}
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	}).pipe(
		Effect.ensuring(
			Effect.sync(() => {
				reader.releaseLock();
			}),
		),
	);
}

function youtubeThumbnail(url: string) {
	try {
		const parsed = new URL(url);
		let videoId: string | null = null;
		if (parsed.hostname === "youtu.be") {
			videoId = parsed.pathname.split("/").filter(Boolean)[0] ?? null;
		}
		if (
			parsed.hostname.endsWith("youtube.com") ||
			parsed.hostname.endsWith("youtube-nocookie.com")
		) {
			videoId = parsed.searchParams.get("v");
			if (!videoId && parsed.pathname.startsWith("/shorts/")) {
				videoId = parsed.pathname.split("/").filter(Boolean)[1] ?? null;
			}
			if (!videoId && parsed.pathname.startsWith("/embed/")) {
				videoId = parsed.pathname.split("/").filter(Boolean)[1] ?? null;
			}
		}
		if (!videoId || !/^[\w-]{6,}$/.test(videoId)) return null;
		return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
	} catch {
		return null;
	}
}

export function extractLinkPreviewMetadata(
	html: string,
	url: string,
): LinkPreviewMetadata {
	const meta = metaContents(html);
	const title =
		pick(meta, ["og:title", "twitter:title"]) ??
		titleFromHtml(html) ??
		hostLabel(url);
	const description = pick(meta, [
		"og:description",
		"twitter:description",
		"description",
	]);
	const siteName =
		pick(meta, ["og:site_name", "application-name"]) ?? hostLabel(url);
	const image =
		pick(meta, [
			"og:image:secure_url",
			"og:image:url",
			"og:image",
			"twitter:image:src",
			"twitter:image",
		]) ?? youtubeThumbnail(url);

	return {
		url,
		title,
		description,
		imageUrl: absoluteUrl(image, url),
		siteName,
	};
}

export function fetchLinkPreviewMetadataEffect(
	url: string,
	options: Pick<
		GetLinkPreviewOptions,
		"fetchImpl" | "resolveHost" | "timeoutMs"
	> = {},
): Effect.Effect<LinkPreviewMetadata> {
	return Effect.gen(function* () {
		const response = yield* safePreviewFetchEffect(url, options);
		const finalUrl = response.url || url;
		const contentType = response.headers.get("content-type") ?? "";
		if (!response.ok) {
			return yield* Effect.fail(new Error(`HTTP ${response.status}`));
		}
		if (contentType.toLowerCase().startsWith("image/")) {
			yield* tryPromise(() => response.body?.cancel() ?? Promise.resolve());
			return {
				url: finalUrl,
				title: hostLabel(finalUrl),
				description: null,
				imageUrl: finalUrl,
				siteName: hostLabel(finalUrl),
			} satisfies LinkPreviewMetadata;
		}
		const content = yield* readResponseTextEffect(response);
		return yield* Effect.try({
			try: () =>
				extractLinkPreviewMetadata(content.slice(0, MAX_HTML_CHARS), finalUrl),
			catch: (error) => error,
		});
	}).pipe(
		Effect.catchAll((error) =>
			Effect.succeed({
				url,
				title: hostLabel(url),
				description: null,
				imageUrl: youtubeThumbnail(url),
				siteName: hostLabel(url),
				error: error instanceof Error ? error.message : String(error),
			}),
		),
	);
}

export function fetchLinkPreviewMetadata(
	url: string,
	options: Pick<
		GetLinkPreviewOptions,
		"fetchImpl" | "resolveHost" | "timeoutMs"
	> = {},
): Promise<LinkPreviewMetadata> {
	return runEffectPromise(fetchLinkPreviewMetadataEffect(url, options));
}

function readCachedPreview(
	db: Database,
	url: string,
	shortUrl: string | null | undefined,
) {
	return db
		.prepare(
			`
      select short_url, expanded_url, final_url, status, title, description,
        image_url, site_name, error, source, updated_at
      from url_expansions
      where short_url in (?, ?)
        or expanded_url in (?, ?)
        or final_url in (?, ?)
      order by
        case
          when short_url = ? then 0
          when final_url = ? then 1
          else 2
        end
      limit 1
      `,
		)
		.get(
			shortUrl ?? url,
			url,
			shortUrl ?? url,
			url,
			shortUrl ?? url,
			url,
			shortUrl ?? url,
			url,
		) as UrlExpansionPreviewRow | undefined;
}

function hasUsefulPreview(row: UrlExpansionPreviewRow) {
	return Boolean(
		row.title || row.description || row.image_url || row.site_name,
	);
}

function rowToPreview(row: UrlExpansionPreviewRow): LinkPreviewMetadata {
	const url = row.final_url || row.expanded_url || row.short_url;
	return {
		url,
		title: row.title ?? null,
		description: row.description ?? null,
		imageUrl: row.image_url ?? null,
		siteName: row.site_name ?? null,
		...(row.error ? { error: row.error } : {}),
	};
}

function persistPreview(
	db: Database,
	url: string,
	shortUrl: string | null | undefined,
	cached: UrlExpansionPreviewRow | undefined,
	preview: LinkPreviewMetadata,
) {
	const now = new Date().toISOString();
	upsertUrlExpansion(
		db,
		normalizeUrlExpansionForIndex({
			url: cached?.short_url ?? shortUrl ?? url,
			expandedUrl: cached?.expanded_url ?? preview.url,
			finalUrl: preview.url,
			status: preview.error ? "error" : "hit",
			title: preview.title,
			description: preview.description,
			imageUrl: preview.imageUrl,
			siteName: preview.siteName,
			...(preview.error ? { error: preview.error } : {}),
			source: "metadata",
			updatedAt: now,
		}),
	);
}

export function getOrFetchLinkPreviewEffect(
	url: string,
	options: GetLinkPreviewOptions = {},
): Effect.Effect<LinkPreviewMetadata> {
	return Effect.gen(function* () {
		const db = getNativeDb({ seedDemoData: false });
		const cached = readCachedPreview(db, url, options.shortUrl);
		if (cached && hasUsefulPreview(cached) && !options.refresh) {
			return rowToPreview(cached);
		}

		const preview = yield* fetchLinkPreviewMetadataEffect(
			cached?.final_url || cached?.expanded_url || url,
			options,
		);
		persistPreview(db, url, options.shortUrl, cached, preview);
		return preview;
	});
}

export function getOrFetchLinkPreview(
	url: string,
	options: GetLinkPreviewOptions = {},
): Promise<LinkPreviewMetadata> {
	return runEffectPromise(getOrFetchLinkPreviewEffect(url, options));
}

export const __test__ = {
	assertSafePreviewUrl,
	decodeHtmlEntities,
	isBlockedAddress,
	respondWithResolvedAddress,
	youtubeThumbnail,
};
