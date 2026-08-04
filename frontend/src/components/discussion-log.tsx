import { useEffect, useRef } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MessageSquare } from "lucide-react";

export interface LogMessage {
  round: number;
  from: string;
  content: string;
}

/** Anonymized discussion log (participants appear as Persona A/B/…). */
export function DiscussionLog({ messages }: { messages: LogMessage[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  return (
    <Card className="flex min-h-0 flex-col">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquare className="h-4 w-4 text-primary" />
          Discussion log
          <span className="text-xs font-normal text-muted-foreground">
            anonymized · scores hidden during debate
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="max-h-96 flex-1 space-y-3 overflow-y-auto p-4 pt-2">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">
            The facilitator's framing and the debate will appear here.
          </p>
        )}
        {messages.map((message, index) => (
          <div key={index} className="animate-fade-in">
            <div className="mb-0.5 flex items-center gap-2">
              <span className="font-mono text-xs font-semibold">{message.from}</span>
              {message.round > 0 && (
                <Badge variant="secondary" className="px-1.5 text-[10px]">
                  round {message.round}
                </Badge>
              )}
            </div>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
              {message.content}
            </p>
          </div>
        ))}
        <div ref={endRef} />
      </CardContent>
    </Card>
  );
}
