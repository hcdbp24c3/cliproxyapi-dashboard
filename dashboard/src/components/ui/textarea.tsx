import { cn } from "@/lib/utils";

interface TextareaProps {
  id?: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  autoComplete?: string;
  spellCheck?: boolean;
}

export function Textarea({
  id,
  name,
  value,
  onChange,
  placeholder,
  rows = 3,
  required = false,
  disabled = false,
  className,
  autoComplete,
  spellCheck,
}: TextareaProps) {
  return (
    <textarea
      id={id ?? name}
      name={name}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      required={required}
      disabled={disabled}
      autoComplete={autoComplete}
      spellCheck={spellCheck}
      className={cn(
        "w-full px-3 py-2 text-sm rounded-md",
        "glass-input text-[var(--text-primary)]",
        "focus:outline-none",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "placeholder:text-[var(--text-muted)] transition-colors duration-200",
        "resize-y",
        className
      )}
    />
  );
}
