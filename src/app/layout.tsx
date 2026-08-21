import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
	title: 'Prospect Copilot',
	description: 'Chat-based sales intelligence: prospect research, qualification, contacts, and outreach.'
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	);
}
