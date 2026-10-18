import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { BookOpen, Send } from "lucide-react";
import { z } from "zod";
import { drobek } from "drobek";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";

const APP_TITLE = "Guestbook";

const entrySchema = z.object({
  name: z.string().trim().min(1, "Tell us your name").max(80),
  message: z.string().trim().min(1, "Write a message").max(500),
});

const messagesCollection = drobek.data.collection<z.infer<typeof entrySchema>>("messages");

const Index = () => {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");

  const { data: messages, isLoading, error } = useQuery({
    queryKey: ["messages"],
    queryFn: async () => (await messagesCollection.list({ sort: "_created_at", dir: "desc" })).records,
  });

  const sign = useMutation({
    mutationFn: async (entry: z.infer<typeof entrySchema>) => {
      await messagesCollection.create(entry);
    },
    onSuccess: () => {
      setMessage("");
      toast.success("Thanks for signing!");
      queryClient.invalidateQueries({ queryKey: ["messages"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = entrySchema.safeParse({ name, message });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0].message);
      return;
    }
    sign.mutate(parsed.data);
  };

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <header className="mb-8 flex items-center gap-3">
        <img src="/logo.png" alt="" width={40} height={40} className="rounded-md" />
        <h1 className="text-3xl font-bold tracking-tight">{APP_TITLE}</h1>
      </header>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <BookOpen /> Sign the guestbook
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="message">Message</Label>
              <Input id="message" value={message} onChange={(e) => setMessage(e.target.value)} />
            </div>
            <Button type="submit" disabled={sign.isPending} className="justify-self-start">
              <Send /> Sign
            </Button>
          </form>
        </CardContent>
      </Card>

      {isLoading && <p className="text-muted-foreground">Loading messages…</p>}
      {error && <p className="text-destructive">Could not load the messages.</p>}
      {messages?.length === 0 && <p className="text-muted-foreground">No messages yet. Be the first!</p>}
      <ul className="grid gap-3">
        {messages?.map((m) => (
          <li key={m._id} className="rounded-lg border bg-card p-4">
            <p>{m.message}</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {m.name} · {formatDistanceToNow(new Date(m._created_at), { addSuffix: true })}
            </p>
          </li>
        ))}
      </ul>
    </main>
  );
};

export default Index;
