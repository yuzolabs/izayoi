import * as SliderPrimitive from "@radix-ui/react-slider";
import * as React from "react";

import { cn } from "@/lib/utils";

type SliderPrimitiveRootProps = React.ComponentPropsWithoutRef<
  typeof SliderPrimitive.Root
>;
type SliderThumbAccessibilityProps = Pick<
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Thumb>,
  | "aria-label"
  | "aria-labelledby"
  | "aria-describedby"
  | "aria-description"
  | "aria-valuetext"
>;

/**
 * Public props for a slider with exactly one interactive thumb.
 *
 * Accessible name, description, and value text props are applied to the thumb,
 * not the roleless root. Multi-thumb sliders are unsupported: `value` and
 * `defaultValue` must each contain exactly one number.
 */
export type SingleThumbSliderProps = Omit<
  SliderPrimitiveRootProps,
  keyof SliderThumbAccessibilityProps | "value" | "defaultValue"
> &
  SliderThumbAccessibilityProps & {
    value?: [number];
    defaultValue?: [number];
  };

/** Renders one keyboard-operable Radix slider thumb. */
const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  SingleThumbSliderProps
>(
  (
    {
      className,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      "aria-describedby": ariaDescribedBy,
      "aria-description": ariaDescription,
      "aria-valuetext": ariaValueText,
      ...rootProps
    },
    ref
  ) => (
    <SliderPrimitive.Root
      ref={ref}
      className={cn("relative flex w-full touch-none select-none items-center", className)}
      {...rootProps}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-secondary">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      {/* 24x24 transparent hit target (WCAG 2.2 target-size, no spacing
          exception needed). The quiet 16px instrument knob lives in a centered
          ::before so the visual scale of the control is unchanged, while the
          focus ring encircles the full hit area. Radix centers the thumb with
          a percentage translate, so track alignment holds at any box size. */}
      <SliderPrimitive.Thumb
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-description={ariaDescription}
        aria-valuetext={ariaValueText}
        className="relative block h-6 w-6 rounded-full before:absolute before:left-1/2 before:top-1/2 before:block before:h-4 before:w-4 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:border before:border-primary/50 before:bg-card before:shadow before:transition-colors hover:before:border-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
      />
    </SliderPrimitive.Root>
  )
);
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
