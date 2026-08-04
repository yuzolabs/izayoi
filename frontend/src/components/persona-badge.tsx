import { groupChipStyle, groupOfType } from "@/lib/persona-meta";
import { cn } from "@/lib/utils";

/** Persona type chip tinted with its 16Personalities group color. */
export function PersonaBadge({
  type,
  name,
  className,
}: {
  type: string;
  name?: string;
  className?: string;
}) {
  const isDiscussion = type.startsWith("DISCUSSION:");
  const baseType = isDiscussion ? type.slice("DISCUSSION:".length) : type;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        className
      )}
      style={groupChipStyle(baseType)}
      title={groupOfType(baseType)?.label}
    >
      <span className="font-mono font-semibold">{baseType}</span>
      {name && <span>{name}</span>}
      {isDiscussion && <span className="opacity-75">· via discussion</span>}
    </span>
  );
}
