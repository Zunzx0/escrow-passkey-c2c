import type { ComponentType, SVGProps } from "react";
import {
  CameraIcon,
  GamepadIcon,
  GridIcon,
  HomeIcon,
  LaptopIcon,
  PhoneIcon,
  ShirtIcon,
  WatchIcon,
} from "../components/ui/icons";

/**
 * Display-only categories. The Listing schema has NO category field, so these
 * are deliberately not clickable and drive no query — showing them as working
 * filters would be faking a backend capability that doesn't exist
 * (redesign spec §9/§40). They exist so the marketplace reads as a shop.
 */
export interface MarketCategory {
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

export const MARKET_CATEGORIES: MarketCategory[] = [
  { label: "Điện thoại", icon: PhoneIcon },
  { label: "Laptop", icon: LaptopIcon },
  { label: "Máy ảnh", icon: CameraIcon },
  { label: "Gaming", icon: GamepadIcon },
  { label: "Phụ kiện", icon: WatchIcon },
  { label: "Gia dụng", icon: HomeIcon },
  { label: "Thời trang", icon: ShirtIcon },
  { label: "Khác", icon: GridIcon },
];

export const CATEGORY_UNAVAILABLE_HINT = "Lọc theo danh mục sẽ có khi hệ thống bổ sung dữ liệu danh mục";
