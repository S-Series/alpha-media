"use client";

import { useCallback, useState, type ReactNode } from "react";
import Navbar from "./navbar";
import Sidebar from "./sidebar";

export default function SiteLayout({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  return (
    <>
      <Navbar
        menuOpen={menuOpen}
        onMenuToggle={() => setMenuOpen((open) => !open)}
        onNavigate={closeMenu}
      />
      <Sidebar open={menuOpen} onClose={closeMenu} />
      <div className="site-container site-body">
        <main id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </>
  );
}
