'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ChatMessage,
  AIAnalysisResult,
  GuardrailCategory,
  TransactionData,
} from '@/types';
import { AIAssistant } from '@/lib/aiAssistant';
import { useStellarWallet } from '@/contexts/StellarWalletContext';
import { useChatHistory } from './useChatHistory';
import { perf } from '@/lib/perf';

interface ConversationState {
  messageCount: number;
  hasUserCancelled: boolean;
  pendingTransactionData: TransactionData | null;
  shouldTriggerTransaction: boolean;
  isAdmin: boolean;
  awaitingClarification: boolean;
  clarificationQuestion: string | null;
}

const useChat = () => {
  const { connection } = useStellarWallet();
  const {
    createNewSession,
    updateCurrentSession,
    loadSession,
    currentSessionId,
    currentSession,
  } = useChatHistory();

  // Conversation flow state
  const [conversationState, setConversationState] = useState<ConversationState>(
    {
      messageCount: 0,
      hasUserCancelled: false,
      pendingTransactionData: null,
      shouldTriggerTransaction: false,
      isAdmin: false,
      awaitingClarification: false,
      clarificationQuestion: null,
    },
  );

  // Modal trigger callback - this will be passed to the chat interface
  const [onTransactionReady, setOnTransactionReady] = useState<
    ((data: TransactionData) => void) | null
  >(null);

  const getInitialSuggestedActions = useCallback(() => {
    if (connection.isConnected) {
      return [
        {
          id: 'portfolio',
          type: 'check_portfolio' as const,
          label: 'Check Portfolio',
        },
        { id: 'convert', type: 'confirm_fiat' as const, label: 'Deposit XLM' },
        { id: 'rates', type: 'market_rates' as const, label: 'Market Rates' },
        { id: 'learn', type: 'learn_more' as const, label: 'How it Works' },
      ];
    } else {
      return [
        {
          id: 'connect',
          type: 'connect_wallet' as const,
          label: 'Connect Freighter',
        },
        { id: 'convert', type: 'confirm_fiat' as const, label: 'Deposit XLM' },
        { id: 'rates', type: 'market_rates' as const, label: 'Market Rates' },
        { id: 'learn', type: 'learn_more' as const, label: 'How it Works' },
      ];
    }
  }, [connection.isConnected]);

  const initialMessage = useMemo(
    () => ({
      id: '1',
      role: 'assistant' as const,
      content: `**Welcome to your Personal USDT-to-Fiat Conversion Center!**

I'm your AI specialist for seamless XLM-to-fiat conversions on Stellar. I can help you:

**Deposit XLM** into the Stellar FiatBridge smart contract
**Get real-time XLM market rates** and conversion estimates
**Setup secure bank transfers** with industry-leading security
**Track transactions** from start to completion on Stellar Expert
**Optimize timing** for better conversion rates

${
  connection.isConnected
    ? `**Freighter Connected**: Ready to check your XLM portfolio and start conversions!`
    : `**Connect Freighter** to get started with personalized XLM portfolio analysis.`
}

What would you like to do today? I'm here to make your XLM-to-fiat journey smooth and profitable!`,
      timestamp: new Date(),
      metadata: {
        suggestedActions: getInitialSuggestedActions(),
      },
    }),
    [getInitialSuggestedActions, connection.isConnected],
  );

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const aiAssistant = useMemo(() => new AIAssistant(), []);
  const activeRequestControllerRef = useRef<AbortController | null>(null);

  const appendCancelledMessage = useCallback((content: string) => {
    const cancelledMessage: ChatMessage = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content,
      timestamp: new Date(),
      metadata: {
        requestStatus: 'cancelled',
      },
    };
    setMessages((prev: ChatMessage[]) => [...prev, cancelledMessage]);
  }, []);

  const cancelPendingRequest = useCallback(() => {
    if (!activeRequestControllerRef.current || !isLoading) {
      return;
    }
    activeRequestControllerRef.current.abort();
    activeRequestControllerRef.current = null;
    setIsLoading(false);
    appendCancelledMessage(
      'Request cancelled. No worries - you can send a new prompt when ready.',
    );
  }, [appendCancelledMessage, isLoading]);

  useEffect(() => {
    if (!isInitialized) {
      if (currentSession && currentSession.messages.length > 0) {
        setMessages(currentSession.messages);
      } else if (!currentSessionId) {
        setMessages([]);
        createNewSession([]);
      }
      setIsInitialized(true);
    }
  }, [
    currentSession,
    currentSessionId,
    createNewSession,
    initialMessage,
    isInitialized,
  ]);

  useEffect(() => {
    if (isInitialized && currentSessionId && messages.length > 0) {
      updateCurrentSession(messages);
    }
  }, [messages, currentSessionId, updateCurrentSession, isInitialized]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (isLoading && activeRequestControllerRef.current) {
        activeRequestControllerRef.current.abort();
        activeRequestControllerRef.current = null;
      }

      const isCancellation = /cancel|stop|no thanks|nevermind|abort/i.test(
        content,
      );
      if (isCancellation) {
        setConversationState((prev: ConversationState) => ({
          ...prev,
          hasUserCancelled: true,
          pendingTransactionData: null,
          shouldTriggerTransaction: false,
          awaitingClarification: false,
          clarificationQuestion: null,
        }));
      }

      const userMessage: ChatMessage = {
        id: Date.now().toString(),
        role: 'user',
        content,
        timestamp: new Date(),
      };

      setMessages((prev: ChatMessage[]) => [...prev, userMessage]);
      setIsLoading(true);
      const requestController = new AbortController();
      activeRequestControllerRef.current = requestController;

      try {
        const conversationContext = {
          isWalletConnected: connection.isConnected,
          walletAddress: connection.address,
          previousMessages: messages
            .slice(-3)
            .map((m: ChatMessage) => ({ role: m.role, content: m.content })),
          messageCount: conversationState.messageCount,
          hasTransactionData: !!conversationState.pendingTransactionData,
        };

        perf.mark('AI: Response');
        const abortPromise = new Promise<never>((_, reject) => {
          requestController.signal.addEventListener(
            'abort',
            () => reject(new DOMException('Request aborted', 'AbortError')),
            { once: true },
          );
        });

        const analysis = await Promise.race([
          aiAssistant.analyzeUserMessage(content, conversationContext),
          abortPromise,
        ]);
        perf.measure('AI: Response');

        const newMessageCount = conversationState.messageCount + 1;
        let shouldTriggerTransaction = false;
        let pendingTransactionData = conversationState.pendingTransactionData;

        if (analysis.intent === 'fiat_conversion' && analysis.extractedData) {
          pendingTransactionData = {
            ...pendingTransactionData,
            ...analysis.extractedData,
          } as TransactionData;
        }

        const hasMinimalTransactionData =
          pendingTransactionData &&
          (pendingTransactionData.tokenIn ||
            pendingTransactionData.amountIn ||
            pendingTransactionData.fiatAmount);
        const needsClarification =
          analysis.intent === 'fiat_conversion' &&
          analysis.confidence < AIAssistant.LOW_CONFIDENCE_THRESHOLD;
        const clarificationQuestion = needsClarification
          ? aiAssistant.getClarificationQuestion(analysis)
          : null;

        const shouldAutoTrigger =
          !needsClarification &&
          !conversationState.hasUserCancelled &&
          (newMessageCount >= 5 ||
            (hasMinimalTransactionData &&
              newMessageCount >= 3 &&
              analysis.intent === 'fiat_conversion'));

        if (shouldAutoTrigger && hasMinimalTransactionData) {
          shouldTriggerTransaction = true;
        }

        let enhancedResponse = analysis.suggestedResponse;

        if (needsClarification && clarificationQuestion) {
          enhancedResponse = `**One quick clarification**: ${clarificationQuestion}`;
        }

        if (
          !needsClarification &&
          newMessageCount >= 3 &&
          hasMinimalTransactionData &&
          !conversationState.hasUserCancelled
        ) {
          enhancedResponse += `

**Ready to Proceed**: I have the details needed for your conversion. Let me set this up for you to review and sign.`;
        } else if (
          !needsClarification &&
          newMessageCount >= 4 &&
          !hasMinimalTransactionData &&
          !conversationState.hasUserCancelled
        ) {
          enhancedResponse += `

**Let's Complete This**: To proceed with your conversion, I'll need either the token amount you want to convert or your desired fiat amount. Once I have that, we can proceed to the secure signing process.`;
        }

        if (!connection.isConnected && analysis.intent === 'fiat_conversion') {
          enhancedResponse +=
            "\\n\\n**Quick Setup**: I notice your wallet isn't connected yet. I'll help you connect it first for a seamless conversion experience.";
        }

        if (
          analysis.intent === 'fiat_conversion' &&
          analysis.extractedData?.tokenIn
        ) {
          const tokenSymbol = analysis.extractedData.tokenIn;
          enhancedResponse += `

**Market Context**: I'll check current ${tokenSymbol} rates to ensure you get the best conversion value.`;
        }

        if (isCancellation) {
          enhancedResponse =
            "**Conversion Cancelled**\\n\\nNo problem! I've cancelled the transaction process. Feel free to start fresh whenever you're ready to convert crypto to fiat. I'm here to help whenever you need assistance.\\n\\nIs there anything else I can help you with today?";
        }

        setConversationState((prev: ConversationState) => ({
          ...prev,
          messageCount: newMessageCount,
          hasUserCancelled: isCancellation ? true : prev.hasUserCancelled,
          pendingTransactionData,
          shouldTriggerTransaction,
          awaitingClarification: needsClarification,
          clarificationQuestion,
        }));

        const shouldShowTransactionData =
          analysis.intent === 'fiat_conversion' &&
          analysis.extractedData &&
          (analysis.extractedData.tokenIn ||
            analysis.extractedData.amountIn ||
            analysis.extractedData.fiatAmount);

        const assistantMessage: ChatMessage = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: enhancedResponse,
          timestamp: new Date(),
          metadata: {
            guardrail: analysis.guardrail,
            transactionData: shouldShowTransactionData
              ? (analysis.extractedData as TransactionData)
              : undefined,
            suggestedActions: generateSuggestedActions(analysis, {
              isWalletConnected: connection.isConnected,
              messageCount: newMessageCount,
              hasTransactionData: !!pendingTransactionData,
              shouldAutoTrigger: !!shouldAutoTrigger,
              isAdmin: conversationState.isAdmin,
              lowConfidence: needsClarification,
            }),
            confirmationRequired:
              analysis.intent === 'fiat_conversion' || shouldTriggerTransaction,
            autoTriggerTransaction: shouldTriggerTransaction,
            conversationCount: newMessageCount,
            lowConfidence: needsClarification,
            clarificationQuestion: clarificationQuestion || undefined,
          },
        };

        setMessages((prev: ChatMessage[]) => [...prev, assistantMessage]);

        if (
          shouldTriggerTransaction &&
          pendingTransactionData &&
          onTransactionReady
        ) {
          setTimeout(() => {
            onTransactionReady(pendingTransactionData);
          }, 1000);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        console.error('Chat error:', error);
        const errorMessage: ChatMessage = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content:
            'Sorry, I encountered an error processing your request. Please try again.',
          timestamp: new Date(),
        };
        setMessages((prev: ChatMessage[]) => [...prev, errorMessage]);
      } finally {
        if (activeRequestControllerRef.current === requestController) {
          activeRequestControllerRef.current = null;
          setIsLoading(false);
        }
      }
    },
    [
      aiAssistant,
      conversationState,
      connection,
      isLoading,
      messages,
      onTransactionReady,
    ],
  );

  const clearChat = useCallback(() => {
    setMessages([]);
    setConversationState((prev: ConversationState) => ({
      messageCount: 0,
      hasUserCancelled: false,
      pendingTransactionData: null,
      shouldTriggerTransaction: false,
      isAdmin: prev.isAdmin,
      awaitingClarification: false,
      clarificationQuestion: null,
    }));
    createNewSession([]);
  }, [createNewSession]);

  const loadChatSession = useCallback(
    (sessionId: string) => {
      const sessionMessages = loadSession(sessionId);
      if (sessionMessages) {
        setMessages(
          sessionMessages.length > 0 ? sessionMessages : [initialMessage],
        );
        setConversationState((prev: ConversationState) => ({
          messageCount: 0,
          hasUserCancelled: false,
          pendingTransactionData: null,
          shouldTriggerTransaction: false,
          isAdmin: prev.isAdmin,
          awaitingClarification: false,
          clarificationQuestion: null,
        }));
      }
    },
    [loadSession, initialMessage],
  );

  const setTransactionReadyCallback = useCallback(
    (callback: (data: TransactionData) => void) => {
      setOnTransactionReady(() => callback);
    },
    [],
  );

  useEffect(() => {
    if (isInitialized) {
      setMessages((prevMessages: ChatMessage[]) => {
        if (prevMessages.length > 0 && prevMessages[0]?.id === '1') {
          const updatedMessages = [...prevMessages];
          updatedMessages[0] = {
            ...updatedMessages[0],
            metadata: {
              ...updatedMessages[0].metadata,
              suggestedActions: getInitialSuggestedActions(),
            },
          };
          return updatedMessages;
        }
        return prevMessages;
      });
    }
  }, [connection.isConnected, getInitialSuggestedActions, isInitialized]);

  return {
    messages,
    isLoading,
    sendMessage,
    clearChat,
    loadChatSession,
    currentSessionId,
    conversationState,
    setTransactionReadyCallback,
    cancelPendingRequest,
    setIsAdmin: (isAdmin: boolean) => {
      setConversationState((prev: ConversationState) => ({ ...prev, isAdmin }));
    },
    addMessage: (message: ChatMessage) => {
      const newMessages = [...messages, message];
      setMessages((prev: ChatMessage[]) => [...prev, message]);
      // Update session with new messages
      updateCurrentSession(newMessages);
    },
  };
};

function generateSuggestedActions(
  analysis: AIAnalysisResult,
  context?: {
    isWalletConnected: boolean;
    messageCount?: number;
    hasTransactionData?: boolean;
    shouldAutoTrigger?: boolean;
    isAdmin?: boolean;
    lowConfidence?: boolean;
  },
) {
  const actions = [];
  const isConnected = context?.isWalletConnected || false;
  const messageCount = context?.messageCount || 0;
  const hasTransactionData = context?.hasTransactionData || false;
  const shouldAutoTrigger = context?.shouldAutoTrigger || false;
  const isAdmin = context?.isAdmin || false;
  const lowConfidence = context?.lowConfidence || false;

  if (analysis.intent === 'guardrail' && analysis.guardrail) {
    return generateGuardrailActions(analysis.guardrail.category, isConnected);
  }

  if (shouldAutoTrigger && hasTransactionData) {
    actions.push({
      id: 'auto_proceed',
      type: 'confirm_fiat' as const,
      label: '🚀 Complete Transaction',
      priority: true,
    });
    actions.push({
      id: 'cancel_flow',
      type: 'cancel' as const,
      label: 'Cancel',
    });
    return actions;
  }

  if (
    messageCount >= 3 &&
    hasTransactionData &&
    !shouldAutoTrigger &&
    !lowConfidence
  ) {
    actions.push({
      id: 'proceed_now',
      type: 'confirm_fiat' as const,
      label: '✨ Proceed with Conversion',
      priority: true,
    });
  }

  if (
    analysis.intent === 'fiat_conversion' &&
    analysis.extractedData &&
    (analysis.extractedData.tokenIn ||
      analysis.extractedData.fiatAmount ||
      analysis.extractedData.fiatCurrency)
  ) {
    if (!isConnected) {
      actions.push({
        id: 'connect_first',
        type: 'connect_wallet' as const,
        label: 'Connect Wallet First',
      });
    }

    if (!shouldAutoTrigger && !lowConfidence) {
      actions.push({
        id: 'proceed_conversion',
        type: 'confirm_fiat' as const,
        label: 'Proceed with Conversion',
        data: analysis.extractedData,
      });
    }

    actions.push({
      id: 'check_rates',
      type: 'market_rates' as const,
      label: 'Check Current Rates',
    });
  }

  if (analysis.intent === 'portfolio') {
    if (!isConnected) {
      actions.push({
        id: 'connect_portfolio',
        type: 'connect_wallet' as const,
        label: 'Connect for Portfolio',
      });
    } else {
      actions.push(
        {
          id: 'view_portfolio',
          type: 'check_portfolio' as const,
          label: 'View Portfolio',
        },
        {
          id: 'convert_options',
          type: 'confirm_fiat' as const,
          label: 'Conversion Options',
        },
      );
    }
  }

  // Admin-only actions
  if (isAdmin) {
    actions.push({
      id: 'admin_withdraw',
      type: 'confirm_fiat' as const,
      label: '💰 Admin: Withdraw Funds',
      data: { isWithdraw: true },
    });
  }

  if (analysis.intent === 'query') {
    const content = analysis.suggestedResponse?.toLowerCase() || '';
    const hasConversionKeywords = [
      'convert',
      'cash',
      'fiat',
      'bank',
      'withdraw',
      'sell',
    ].some((keyword) => content.includes(keyword));
    if (hasConversionKeywords && !lowConfidence) {
      actions.push(
        {
          id: 'start_conversion',
          type: 'confirm_fiat' as const,
          label: 'Deposit XLM',
        },
        {
          id: 'market_info',
          type: 'market_rates' as const,
          label: 'Market Info',
        },
      );
    } else {
      actions.push({
        id: 'convert_crypto',
        type: 'confirm_fiat' as const,
        label: 'Convert Crypto',
      });

      if (isConnected) {
        actions.push({
          id: 'portfolio_check',
          type: 'check_portfolio' as const,
          label: 'Check Portfolio',
        });
      }

      actions.push({
        id: 'learn_process',
        type: 'learn_more' as const,
        label: 'Learn Process',
      });
    }
  }

  if (analysis.intent === 'technical_support') {
    actions.push(
      { id: 'retry_action', type: 'confirm_fiat' as const, label: 'Try Again' },
      {
        id: 'check_status',
        type: 'check_portfolio' as const,
        label: 'Check Status',
      },
    );
  }

  if (analysis.intent === 'unknown') {
    actions.push(
      {
        id: 'explore_conversion',
        type: 'confirm_fiat' as const,
        label: 'Explore Conversions',
      },
      {
        id: 'how_it_works',
        type: 'learn_more' as const,
        label: 'How It Works',
      },
    );
  }

  return actions;
}

function generateGuardrailActions(
  category: GuardrailCategory,
  isWalletConnected: boolean,
) {
  const actions = [];

  if (!isWalletConnected) {
    actions.push({
      id: 'guardrail_connect_wallet',
      type: 'connect_wallet' as const,
      label: 'Connect Freighter',
    });
  }

  if (category === 'unsupported_request') {
    actions.push({
      id: 'guardrail_supported_question',
      type: 'query' as const,
      label: 'Show Supported Tasks',
      data: {
        query:
          'What supported actions can you help me with in Stellar Dex Chat?',
      },
    });
  }

  actions.push({
    id: 'guardrail_market_rates',
    type: 'market_rates' as const,
    label: 'Check XLM Rates',
  });
  actions.push({
    id: 'guardrail_learn_more',
    type: 'learn_more' as const,
    label: 'How It Works',
  });

  return actions;
}

export default useChat;
