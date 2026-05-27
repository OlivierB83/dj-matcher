import { Heart } from "lucide-react";

export function CompatBadge({ level, label }) {
  const cls = {
    perfect: "badge badge-perfect",
    close: "badge badge-close",
    far: "badge badge-far",
  }[level];

  return <span className={cls}>{label}</span>;
}

export function FavBadge() {
  return (
    <span className="badge badge-fav">
      <Heart size={10} fill="currentColor" />
      favori
    </span>
  );
}
