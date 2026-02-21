import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ReactNode, KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { AppIcon } from "./AppIcon";
import "./Select.css";

export type SelectOption = {
  value: string;
  label: ReactNode;
  disabled?: boolean;
};

type SelectProps = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  wrapperClassName?: string;
  menuClassName?: string;
  ariaLabel?: string;
};

const findNextEnabledIndex = (
  options: SelectOption[],
  startIndex: number,
  delta: number,
) => {
  if (options.length === 0) return -1;
  let nextIndex = startIndex;
  for (let i = 0; i < options.length; i += 1) {
    nextIndex = (nextIndex + delta + options.length) % options.length;
    if (!options[nextIndex]?.disabled) return nextIndex;
  }
  return -1;
};

export function Select({
  value,
  options,
  onChange,
  placeholder,
  disabled = false,
  className,
  wrapperClassName,
  menuClassName,
  ariaLabel,
}: SelectProps) {
  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();

  const selectedIndex = useMemo(
    () => options.findIndex((opt) => opt.value === value),
    [options, value],
  );

  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;
  const hasValue = Boolean(value);
  const displayLabel = selectedOption?.label ?? (hasValue ? value : placeholder);
  const isPlaceholder = !selectedOption && !hasValue && Boolean(placeholder);
  const activeOptionId =
    open && activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined;

  useEffect(() => {
    if (!open) {
      setMenuStyle(undefined);
      return;
    }
    const initialIndex =
      selectedIndex >= 0 && !options[selectedIndex]?.disabled
        ? selectedIndex
        : findNextEnabledIndex(options, -1, 1);
    setActiveIndex(initialIndex);
  }, [open, options, selectedIndex]);

  useEffect(() => {
    if (!open) {
      setMenuStyle(undefined);
      return;
    }

    const gap = 6;
    const viewportMargin = 8;
    const maxMenuHeight = 260;

    const updateMenuPosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(rect.width, window.innerWidth - viewportMargin * 2);
      const left = Math.min(
        window.innerWidth - viewportMargin - width,
        Math.max(viewportMargin, rect.left),
      );
      const spaceBelow = window.innerHeight - rect.bottom - viewportMargin;
      const spaceAbove = rect.top - viewportMargin;
      const openUpward = spaceBelow < 180 && spaceAbove > spaceBelow;
      const available = openUpward ? spaceAbove : spaceBelow;
      const height = Math.max(120, Math.min(maxMenuHeight, available - gap));
      const top = openUpward
        ? rect.top - gap - height
        : rect.bottom + gap;

      setMenuStyle({
        position: "fixed",
        top: Math.max(viewportMargin, Math.round(top)),
        left: Math.round(left),
        width: Math.round(width),
        minWidth: Math.round(width),
        maxHeight: Math.round(height),
      });
    };

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);

    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };

    const onWindowBlur = () => setOpen(false);

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [open]);

  const handleSelect = (nextValue: string) => {
    if (nextValue !== value) {
      onChange(nextValue);
    }
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        if (!open) setOpen(true);
        setActiveIndex((prev) =>
          findNextEnabledIndex(
            options,
            open ? prev : selectedIndex,
            1,
          ),
        );
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        if (!open) setOpen(true);
        setActiveIndex((prev) =>
          findNextEnabledIndex(
            options,
            open ? prev : selectedIndex,
            -1,
          ),
        );
        break;
      }
      case "Home": {
        event.preventDefault();
        const nextIndex = findNextEnabledIndex(options, -1, 1);
        if (!open) setOpen(true);
        setActiveIndex(nextIndex);
        break;
      }
      case "End": {
        event.preventDefault();
        const nextIndex = findNextEnabledIndex(options, 0, -1);
        if (!open) setOpen(true);
        setActiveIndex(nextIndex);
        break;
      }
      case "Enter":
      case " ": {
        event.preventDefault();
        if (!open) {
          setOpen(true);
        } else if (activeIndex >= 0) {
          const option = options[activeIndex];
          if (option && !option.disabled) {
            handleSelect(option.value);
          }
        }
        break;
      }
      case "Escape": {
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        break;
      }
      case "Tab": {
        setOpen(false);
        break;
      }
      default:
        break;
    }
  };

  return (
    <div
      className={[
        "select",
        open ? "select--open" : "",
        wrapperClassName,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        ref={triggerRef}
        className={
          ["select-trigger", className].filter(Boolean).join(" ")
        }
        onClick={() => {
          if (disabled) return;
          setOpen((prev) => !prev);
        }}
        onKeyDown={handleKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
        disabled={disabled}
      >
        <span
          className={`select-value${isPlaceholder ? " select-placeholder" : ""}`}
        >
          {displayLabel}
        </span>
        <AppIcon
          icon="material-symbols:keyboard-arrow-down-rounded"
          size={16}
          className="select-caret"
        />
      </button>
      {open &&
        menuStyle &&
        createPortal(
          <div
            className={["select-menu", "select-menu--portal", menuClassName].filter(Boolean).join(" ")}
            role="listbox"
            id={listboxId}
            ref={menuRef}
            style={menuStyle}
          >
            {options.map((option, index) => {
              const isSelected = option.value === value;
              const isActive = index === activeIndex;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  id={`${listboxId}-opt-${index}`}
                  aria-selected={isSelected}
                  className={[
                    "select-option",
                    isSelected ? "select-option--selected" : "",
                    isActive ? "select-option--active" : "",
                    option.disabled ? "select-option--disabled" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => {
                    if (!option.disabled) {
                      handleSelect(option.value);
                    }
                  }}
                  disabled={option.disabled}
                >
                  {option.label}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
