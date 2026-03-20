'use client';

import { ThemeProvider } from '@/contexts/ThemeContext';
import { StellarWalletProvider } from '@/contexts/StellarWalletContext';
import { useTheme } from '@/contexts/ThemeContext';
import ErrorBoundary from '@/components/ErrorBoundary';
import StellarChatInterface from '@/components/StellarChatInterface';

function ChatPageContent() {
    const { isDarkMode } = useTheme();

    return (
        <main className="h-screen w-screen overflow-hidden">
            <ErrorBoundary isDarkMode={isDarkMode}>
                <StellarChatInterface />
            </ErrorBoundary>
        </main>
    );
}

export default function ChatPage() {
    return (
        <ThemeProvider>
            <StellarWalletProvider>
                <ChatPageContent />
            </StellarWalletProvider>
        </ThemeProvider>
    );
}
