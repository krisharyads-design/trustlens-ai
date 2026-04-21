import "./globals.css";

export const metadata = {
  title: "TrustLens AI",
  description: "Simple AI media trust checker built with Next.js and Gemini Vision.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
