interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
  htmlFor?: string;
}

export function Field({ label, hint, children, htmlFor }: FieldProps) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && (
        <div className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>
          {hint}
        </div>
      )}
    </div>
  );
}
