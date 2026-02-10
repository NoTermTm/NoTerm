import { Icon } from "@iconify/react";

type AppIconProps = {
  icon: string;
  size?: number;
  className?: string;
  title?: string;
};

export function AppIcon({ icon, size = 16, className, title }: AppIconProps) {
  return (
    <Icon
      icon={icon}
      width={size}
      height={size}
      className={["app-icon", className].filter(Boolean).join(" ")}
      aria-hidden={title ? undefined : true}
    />
  );
}
