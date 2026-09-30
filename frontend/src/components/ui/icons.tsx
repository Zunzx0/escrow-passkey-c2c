import type { SVGProps } from "react";

/**
 * Minimal thin-line "technical" icon set (ke-hoach FE design review §1.4/§24:
 * "icon nét mảnh, công nghệ" — never playful/cartoon glyphs). Hand-written
 * instead of pulling in an icon library, to keep the bundle small.
 */
function Base(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props} />;
}

export function ShieldIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </Base>
  );
}

export function LockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 118 0v4" />
    </Base>
  );
}

export function WalletIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18" />
      <circle cx="16" cy="14" r="1" fill="currentColor" stroke="none" />
    </Base>
  );
}

export function PasskeyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M11.5 10.5L20 19M17 16l2-2M14.5 13.5l1.8-1.8" />
    </Base>
  );
}

export function PackageIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M21 8l-9-5-9 5 9 5 9-5z" />
      <path d="M3 8v8l9 5 9-5V8M12 13v8" />
    </Base>
  );
}

export function CheckCircleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </Base>
  );
}

export function AlertIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M12 3l9 16H3l9-16z" />
      <path d="M12 10v4M12 17.5h.01" />
    </Base>
  );
}

export function ChevronRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M9 6l6 6-6 6" />
    </Base>
  );
}

export function BellIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M6 10a6 6 0 1112 0c0 4 1.5 5.5 1.5 5.5H4.5S6 14 6 10z" />
      <path d="M10 19a2 2 0 004 0" />
    </Base>
  );
}

export function PhoneIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M11 5.5h2M10.5 18.5h3" />
    </Base>
  );
}

export function LaptopIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <rect x="4" y="5" width="16" height="11" rx="1.5" />
      <path d="M2 19h20" />
    </Base>
  );
}

export function CameraIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M4 8h3l1.5-2.5h7L17 8h3a1.5 1.5 0 011.5 1.5v8A1.5 1.5 0 0120 19H4a1.5 1.5 0 01-1.5-1.5v-8A1.5 1.5 0 014 8z" />
      <circle cx="12" cy="13" r="3.5" />
    </Base>
  );
}

export function GamepadIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M7.5 8h9a5 5 0 014.4 7.3l-.9 1.8a2.2 2.2 0 01-3.8.3L15 16H9l-1.2 1.4a2.2 2.2 0 01-3.8-.3l-.9-1.8A5 5 0 017.5 8z" />
      <path d="M6.5 12h3M8 10.5v3M16 11h.01M18 13.5h.01" />
    </Base>
  );
}

export function WatchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <rect x="8" y="7" width="8" height="10" rx="2.5" />
      <path d="M9.5 7V4h5v3M9.5 17v3h5v-3M12 10.5V13h2" />
    </Base>
  );
}

export function HomeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M4 10.5L12 4l8 6.5V20a1 1 0 01-1 1H5a1 1 0 01-1-1z" />
      <path d="M9.5 21v-6h5v6" />
    </Base>
  );
}

export function ShirtIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M9 3.5l3 2 3-2 5 3-2 3-1.5-.8V20.5h-9V8.7L6 9.5l-2-3z" />
    </Base>
  );
}

export function GridIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </Base>
  );
}

export function FilterIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M3.5 6h17M6.5 12h11M10 18h4" />
    </Base>
  );
}

export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </Base>
  );
}

export function SearchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </Base>
  );
}

export function TabletIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <rect x="5" y="2.5" width="14" height="19" rx="2.5" />
      <path d="M10.5 18.5h3" />
    </Base>
  );
}

export function HeadphonesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M4 14v-2a8 8 0 0116 0v2" />
      <path d="M4 14a2 2 0 012-2h1v7H6a2 2 0 01-2-2v-3zM20 14a2 2 0 00-2-2h-1v7h1a2 2 0 002-2v-3z" />
    </Base>
  );
}

export function SpeakerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <rect x="6" y="3" width="12" height="18" rx="2" />
      <circle cx="12" cy="14" r="4" />
      <circle cx="12" cy="7" r="1.2" />
    </Base>
  );
}

export function KeyboardIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M6 13.5h.01M9 13.5h.01M12 13.5h6M6 16h8" />
    </Base>
  );
}

export function MouseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <rect x="7" y="2.5" width="10" height="19" rx="5" />
      <path d="M12 2.5v6M9.5 8.5h5" />
    </Base>
  );
}

export function MonitorIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </Base>
  );
}

export function BicycleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <circle cx="6" cy="17" r="4" />
      <circle cx="18" cy="17" r="4" />
      <path d="M6 17l4-8 3 8h-7zm4-8h5l3 8M9 6h3M15 6h3" />
    </Base>
  );
}

export function VacuumIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <circle cx="10" cy="14" r="6" />
      <circle cx="10" cy="14" r="1" />
      <path d="M14 5h3l3 12M17 5V3M19 19h3" />
    </Base>
  );
}

export function BookIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M4 4.5h5a3 3 0 013 3v12a3 3 0 00-3-3H4zM20 4.5h-5a3 3 0 00-3 3v12a3 3 0 013-3h5z" />
    </Base>
  );
}
