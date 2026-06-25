"use client";

import type { MouseEvent, ReactNode } from "react";
import {
  openFilePathOnHost,
  parseLocalFileHref,
} from "@/lib/workspace-tabs/file-path-actions";

/**
 * Anchor renderer shared by the chat markdown surfaces. Web URLs open in the
 * system browser as before; links that point at a local filesystem path are
 * opened on the host (the default app via Electron's shell) instead of being
 * treated as a navigation, which would otherwise resolve against the app
 * origin and load a broken `http://localhost/<path>` page.
 */
export function MarkdownLink({
  href,
  className,
  children,
}: {
  href?: string;
  className?: string;
  children?: ReactNode;
}) {
  const filePath = parseLocalFileHref(href);

  if (filePath) {
    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      openFilePathOnHost(filePath);
    };
    return (
      <a
        href={href}
        onClick={handleClick}
        className={className}
        title={filePath}
        data-file-link="true"
      >
        {children}
      </a>
    );
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}
