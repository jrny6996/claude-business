interface BannerProps {
  tone?: "accent" | "neutral";
  title?: string;
  children?: React.ReactNode;
  items?: string[];
}

/** Inline messaging: warnings from a generation, errors, key prompts. */
export function Banner({ tone = "accent", title, children, items }: BannerProps) {
  return (
    <div className={tone === "accent" ? "banner" : "banner banner-neutral"}>
      {title && <strong>{title}</strong>}
      {children}
      {items && items.length > 0 && (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
