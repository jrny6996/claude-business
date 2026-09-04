import { useState } from "react";
import type { SecretMetadata } from "@repo/shared";
import { Field } from "./Field.js";

interface SecretFieldProps {
  label: string;
  hint: string;
  placeholder: string;
  meta: SecretMetadata | undefined;
  busy: boolean;
  onSave: (value: string) => void;
  onClear?: () => void;
}

/**
 * Entry for a BYOK secret.
 *
 * The stored value is never sent back to the renderer, so this shows the
 * `last4` hint the API returns rather than the key itself, and the input always
 * starts empty.
 */
export function SecretField({
  label,
  hint,
  placeholder,
  meta,
  busy,
  onSave,
  onClear,
}: SecretFieldProps) {
  const [value, setValue] = useState("");
  const id = `secret-${label.replace(/\s+/g, "-").toLowerCase()}`;

  return (
    <div className="stack-tight">
      <Field label={label} hint={hint} htmlFor={id}>
        <input
          id={id}
          className="input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>

      <div className="inline-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || value.trim().length === 0}
          onClick={() => {
            onSave(value.trim());
            setValue("");
          }}
        >
          {meta?.present ? "Replace key" : "Save key"}
        </button>

        {meta?.present && onClear && (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClear}>
            Remove
          </button>
        )}
      </div>

      <div className="text-muted" style={{ fontSize: 12 }}>
        {meta?.present ? (
          <>
            Saved
            {meta.last4 ? (
              <>
                {" "}
                &middot; ends in <span className="mono">{meta.last4}</span>
              </>
            ) : null}
            {meta.lastValidatedAt ? " · validated" : " · not yet validated"}
          </>
        ) : (
          "Not set"
        )}
      </div>
    </div>
  );
}
