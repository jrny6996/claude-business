import { useState } from "react";

/**
 * A command the user is expected to run in their own terminal, with a copy
 * button.
 *
 * Every deploy and dev-environment instruction in this app is a command *they*
 * run — we emit it, their tooling executes it. Making it copyable is the
 * difference between that being a workflow and being a transcription exercise.
 */
export function CodeBlock({
  children,
  label = "Copy",
}: {
  children: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused; the text is selectable either way.
    }
  };

  return (
    <div className="code-copy">
      <pre className="code-block">{children}</pre>
      <button type="button" className="btn btn-secondary" onClick={() => void copy()}>
        {copied ? "Copied" : label}
      </button>
    </div>
  );
}
