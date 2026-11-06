import type { Metadata } from "next";
import { Providers } from "./providers";
import "./styles.css";
export const metadata: Metadata = {
  title: "LendLoop — Borrow nearby",
  description: "A neighborhood tool-lending board.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
