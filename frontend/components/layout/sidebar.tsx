import Link from "next/link";
import { useEffect, useRef } from "react";
import { navigation } from "./navigation";

type SidebarProps = {
  open: boolean;
  onClose: () => void;
};

export default function Sidebar({ open, onClose }: SidebarProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;

    const desktop = window.matchMedia("(min-width: 768px)");
    if (desktop.matches) {
      onClose();
      return;
    }

    dialog.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) onClose();
    };
    desktop.addEventListener("change", closeOnDesktop);

    return () => {
      desktop.removeEventListener("change", closeOnDesktop);
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
    };
  }, [open, onClose]);

  return (
    <dialog
      id="site-sidebar"
      ref={dialogRef}
      className="sidebar-dialog"
      aria-labelledby="sidebar-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className="sidebar" aria-label="빠른 메뉴">
        <div className="sidebar-heading">
          <h2 id="sidebar-title">바로가기</h2>
          <button type="button" onClick={onClose} aria-label="사이드바 닫기">×</button>
        </div>
        <nav aria-label="바로가기">
          {navigation.map((item) => (
            <Link href={item.href} key={item.href} onClick={onClose}>{item.label}</Link>
          ))}
        </nav>
        <a href="#top" onClick={onClose}>맨 위로</a>
      </aside>
    </dialog>
  );
}
