import Link from "next/link";
import { navigation } from "./navigation";

type NavbarProps = {
  menuOpen: boolean;
  onMenuToggle: () => void;
  onNavigate: () => void;
};

export default function Navbar({ menuOpen, onMenuToggle, onNavigate }: NavbarProps) {
  return (
    <header className="site-header">
      <div className="site-container navbar">
        <Link href="/" aria-label="Alpha Media 홈" onClick={onNavigate}>Alpha Media</Link>
        <nav aria-label="주 메뉴" className="primary-nav">
          {navigation.map((item) => (
            <Link href={item.href} key={item.href} onClick={onNavigate}>{item.label}</Link>
          ))}
        </nav>
        <button
          type="button"
          className="menu-toggle"
          aria-label={menuOpen ? "메뉴 닫기" : "메뉴 열기"}
          aria-expanded={menuOpen}
          aria-controls="site-sidebar"
          onClick={onMenuToggle}
        >
          <span aria-hidden="true">{menuOpen ? "×" : "☰"}</span>
        </button>
      </div>
    </header>
  );
}
