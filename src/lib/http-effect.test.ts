import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { jsonResponse, requestJsonEffect, runRouteEffect } from "./http-effect";

describe("http Effect helpers", () => {
	it("serializes json responses and preserves custom init headers", async () => {
		const response = jsonResponse(
			{ ok: true },
			{ status: 202, headers: { "x-test": "yes" } },
		);

		expect(response.status).toBe(202);
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(response.headers.get("x-test")).toBe("yes");
		await expect(response.json()).resolves.toEqual({ ok: true });
	});

	it("preserves Headers instances passed through ResponseInit", () => {
		const response = jsonResponse(
			{ ok: true },
			{ headers: new Headers({ "cache-control": "no-store" }) },
		);

		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("content-type")).toBe("application/json");
	});

	it("parses request JSON through an Effect boundary", async () => {
		await expect(
			runRouteEffect(
				requestJsonEffect(
					new Request("http://localhost/api", {
						method: "POST",
						body: JSON.stringify({ kind: "sync" }),
					}),
				),
			),
		).resolves.toEqual({ kind: "sync" });
	});

	it("uses fallback JSON values when parsing fails", async () => {
		await expect(
			runRouteEffect(
				requestJsonEffect(
					new Request("http://localhost/api", {
						method: "POST",
						body: "{",
					}),
					{ kind: "fallback" },
				),
			),
		).resolves.toEqual({ kind: "fallback" });
	});

	it("fails JSON parsing when no fallback is supplied", async () => {
		await expect(
			runRouteEffect(
				requestJsonEffect(
					new Request("http://localhost/api", {
						method: "POST",
						body: "{",
					}),
				),
			),
		).rejects.toBeInstanceOf(Error);
	});

	it("runs arbitrary route effects", async () => {
		await expect(runRouteEffect(Effect.succeed("ok"))).resolves.toBe("ok");
	});
});
