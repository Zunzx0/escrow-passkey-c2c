import { createElement, type ComponentType, type ReactElement, type SVGProps } from "react";
import {
  BicycleIcon,
  BookIcon,
  CameraIcon,
  GamepadIcon,
  HeadphonesIcon,
  HomeIcon,
  KeyboardIcon,
  LaptopIcon,
  MonitorIcon,
  MouseIcon,
  PackageIcon,
  PhoneIcon,
  SpeakerIcon,
  TabletIcon,
  VacuumIcon,
  WatchIcon,
} from "../components/ui/icons";

type ProductIcon = ComponentType<SVGProps<SVGSVGElement>>;

const ICON_RULES: Array<{ words: string[]; icon: ProductIcon }> = [
  { words: ["iphone", "samsung", "galaxy", "điện thoại", "smartphone", "pixel"], icon: PhoneIcon },
  { words: ["ipad", "tablet", "máy tính bảng", "kindle"], icon: TabletIcon },
  { words: ["macbook", "laptop", "thinkpad", "dell", "asus", "acer", "máy tính xách tay"], icon: LaptopIcon },
  { words: ["màn hình", "monitor", "display"], icon: MonitorIcon },
  { words: ["máy ảnh", "camera", "canon", "nikon", "fujifilm", "ống kính", "lens"], icon: CameraIcon },
  { words: ["playstation", "ps5", "ps4", "xbox", "nintendo", "switch", "tay cầm", "gamepad", "gaming"], icon: GamepadIcon },
  { words: ["tai nghe", "airpods", "headphone", "earbuds", "headset"], icon: HeadphonesIcon },
  { words: ["loa", "speaker", "soundbar", "jbl"], icon: SpeakerIcon },
  { words: ["bàn phím", "keyboard"], icon: KeyboardIcon },
  { words: ["chuột", "mouse"], icon: MouseIcon },
  { words: ["đồng hồ", "watch", "smartwatch"], icon: WatchIcon },
  { words: ["xe đạp", "bicycle", "bike"], icon: BicycleIcon },
  { words: ["robot hút bụi", "máy hút bụi", "vacuum"], icon: VacuumIcon },
  { words: ["sách", "book", "truyện"], icon: BookIcon },
  { words: ["nồi", "bếp", "máy giặt", "tủ lạnh", "gia dụng"], icon: HomeIcon },
];

export function productIconForName(name: string, props: SVGProps<SVGSVGElement>): ReactElement {
  const normalized = name.toLocaleLowerCase("vi-VN");
  const Icon = ICON_RULES.find(({ words }) => words.some((word) => normalized.includes(word)))?.icon ?? PackageIcon;
  return createElement(Icon, props);
}
