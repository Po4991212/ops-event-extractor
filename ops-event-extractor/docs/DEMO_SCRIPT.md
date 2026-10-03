# Five-minute demonstration

Run `npm install` first. Nothing here touches a real system.

## 0:00 — Show what it cannot do

```
npm run ops -- scan-nosend
```

> Sixty-odd source files, zero send capability. This scanner runs in CI and
> fails the build if anyone adds Gmail send, SMTP, or an email provider SDK —
> including inside a comment. The system drafts. A person sends.

## 0:40 — Load the corpus and process it

```
npm run ops -- init
npm run ops -- seed-synthetic
npm run ops -- process
```

> Thirty-six messages, twenty-seven obligations, three held back, one routed as
> noise. The three held back are the interesting ones.

## 1:20 — The three it refused

```
npm run ops -- review
```

Open `http://127.0.0.1:8766` and go to the held column.

> First one: the extractor quoted a sentence that is not in the message. Second:
> it quoted nothing at all. Third is the one worth dwelling on — the quoted
> sentence is real. It says "our office will be closed on 07/04/2026." That is a
> genuine date in a genuine sentence, and it substantiates nothing about when a
> renewal is owed. The system says so in those words.

## 2:10 — Evidence is the interface

Open any obligation.

> The verbatim span is the biggest thing on the page, in monospace, because the
> question a broker is answering is "does the quoted text actually say this."
> The renewal premium came out of an HTML table, and the span is the table row.

## 2:50 — Three forwards, one obligation

Find the TWIA renewal.

> One notice, forwarded twice internally and once into a second mailbox. Four
> source links, one obligation, one task. The clock runs from when the notice
> first arrived, not from when the last person forwarded it — a colleague
> forwarding something does not buy you three more days.
>
> The same thread also carries a windstorm inspection form with its own
> deadline. Different obligation. It stays separate.

## 3:30 — Saying is not doing

```
npm run ops -- fulfillment
```

> Someone said on a call "we'll remove the 2017 Isuzu." That is a promise. It
> closed when an endorsement document appeared in the agency system carrying
> that VIN. An endorsement for a different vehicle on the same account did not
> close it. A note this system wrote itself cannot close it — that one is
> rejected by name.
>
> A payment closed on a matching receipt, then reopened when the reversal
> arrived.

## 4:10 — Silence

```
npm run ops -- sweep
npm run ops -- sweep
```

> We asked a client for payroll figures. A reply came back in the same thread
> about something else entirely. The clock kept running, because the reply did
> not answer the question. The first sweep fires the escalations. The second
> fires nothing — one row per task per level, so a restart cannot double-remind.

## 4:40 — What it would write

```
npm run ops -- qq-dryrun
```

> Twenty-three notes built, none sent. Sending needs `--live` on the command
> *and* an environment variable set on the machine. Either one alone leaves you
> here. The payload you are reading is byte-for-byte what would go.

## Close

```
npm test
```

> Forty tests. The nine acceptance scenarios, the failure stories, and the
> security properties. Four of those tests exist because they caught real bugs
> during the build — the worst being a forward silently erasing a premium the
> original notice stated.
