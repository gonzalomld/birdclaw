import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "#/lib/theme";

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		to,
		className,
		...props
	}: {
		children: ReactNode;
		to: string;
		className: string;
		[key: string]: unknown;
	}) => (
		<a className={className} href={to} {...props}>
			{children}
		</a>
	),
	useRouterState: ({
		select,
	}: {
		select: (state: { location: { pathname: string } }) => string;
	}) => select({ location: { pathname: "/inbox" } }),
}));

vi.mock("./AccountSwitcher", () => ({
	AccountSwitcher: () => null,
}));

import { AppNav } from "./AppNav";

describe("AppNav", () => {
	it("marks the active route", () => {
		render(
			<ThemeProvider>
				<AppNav />
			</ThemeProvider>,
		);

		expect(screen.getByRole("link", { name: "Inbox" })).toHaveClass(
			"nav-link-active",
		);
		expect(screen.getByRole("link", { name: "Inbox" })).toHaveAttribute(
			"aria-label",
			"Inbox",
		);
		expect(screen.getByRole("link", { name: "Blocks" })).toBeInTheDocument();
		expect(
			screen.getByText("Fast search for your archive."),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: "Theme: System default. Switch to Light theme.",
			}),
		).toBeInTheDocument();
	});
});
