"use client"

import { cn } from "../../lib/utils"
import React, { useEffect, useState } from "react"
import { Copy, Check } from "lucide-react"

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

export function CopyButton({ value, className, inline }) {
  const [copied, setCopied] = useState(false)

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      // clipboard may be unavailable; ignore
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label="Copy"
      title="Copy"
      className={cn(
        "inline-flex items-center justify-center gap-1 rounded-md p-1.5 text-gray-300 transition-colors hover:text-white",
        inline
          ? copied
            ? "text-green-400"
            : ""
          : "absolute right-2 top-2 z-10 border border-gray-600 bg-[#1a1b1e]/90 opacity-0 group-hover:opacity-100 focus:opacity-100",
        className
      )}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {inline && copied && <span className="text-xs">Copied</span>}
    </button>
  )
}

export function CodeBlock({ children, className, ...props }) {
  return (
    <div
      className={cn(
        "not-prose group relative flex w-full flex-col overflow-clip border rounded-xl",
        "border-gray-700 bg-[#1a1b1e] text-gray-100 my-3",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

// shiki is large, so it loads the first time a code block is highlighted.
let shikiPromise = null
const loadShiki = () =>
  (shikiPromise ??= import("shiki").catch((e) => {
    shikiPromise = null
    throw e
  }))

// `highlight={false}` (while a reply is streaming) shows plain code and skips
// shiki, which would otherwise re-run on every token.
export function CodeBlockCode({ code, language = "tsx", theme = "github-dark", highlight = true, className, ...props }) {
  const [highlightedHtml, setHighlightedHtml] = useState(null)

  useEffect(() => {
    if (!highlight) {
      setHighlightedHtml(null)
      return
    }
    let active = true
    async function run() {
      if (!code) {
        if (active) setHighlightedHtml("<pre><code></code></pre>")
        return
      }
      try {
        const { codeToHtml } = await loadShiki()
        const html = await codeToHtml(code, { lang: language, theme })
        if (active) setHighlightedHtml(html)
      } catch (e) {
        // Fallback to plain (escaped) code if highlighting fails for a lang
        if (active) setHighlightedHtml(`<pre><code>${escapeHtml(code)}</code></pre>`)
      }
    }
    run()
    return () => {
      active = false
    }
  }, [code, language, theme, highlight])

  const classNames = cn(
    "w-full overflow-x-auto text-[13px] [&>pre]:px-4 [&>pre]:py-4 [&>pre]:bg-transparent [&>pre]:m-0",
    className
  )

  return highlightedHtml ? (
    <div className={classNames} dangerouslySetInnerHTML={{ __html: highlightedHtml }} {...props} />
  ) : (
    <div className={classNames} {...props}>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

export function CodeBlockGroup({ children, className, ...props }) {
  return (
    <div
      className={cn(
        "flex items-center justify-between border-b border-gray-700 px-4 py-2",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}
