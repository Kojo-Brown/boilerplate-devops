# Postmortems: what gets written afterwards, and the review that keeps it honest

Everything else in this repository makes a failure visible and puts a procedure
in the responder's hand. None of it changes anything afterwards. The page
clears, the responder goes back to bed, and three weeks later the same
contributing factors produce the same incident — which nothing reports, because
an incident nobody wrote up and an incident that taught us nothing are the same
row in the same empty table, and both look like a quiet month.

This item is the other half of [docs/runbooks.md](./runbooks.md). The runbook is
what the responder reads at 04:00; this is what the same people write on
Thursday afternoon, and the reason the *next* runbook is better than this one.

Three things go wrong, and all three are invisible in review:

**Nothing triggers a postmortem.** "Was that bad enough to write up?" gets
decided at the end of a long night by the person least able to judge it, and the
answer trends to no. [§2](#2-which-incidents-owe-one) makes the trigger a fact
about the incident — a signal that fired, a budget spend, a class of impact —
rather than a judgement call.

**The template asks who.** A timeline that names people is a performance review
with the grammar of an analysis. The cost is not unfairness: it is that everyone
who reads it afterwards edits their own answers, so the document stops recording
what was actually known at the time, which is the only thing in it worth having.
[§3](#3-blameless-is-a-property-of-the-document) is what the template does
instead, and the gate refuses the phrases that undo it.

**The three copies drift.** The process is this document, the thing people fill
in is
[`.github/ISSUE_TEMPLATE/postmortem.yml`](../.github/ISSUE_TEMPLATE/postmortem.yml),
and the review reads off a checklist. Nothing in GitHub reconciles them.
`aws/cdk/lib/postmortems.ts` is the single declaration and
`npm run audit:postmortems` holds the other two against it, in both directions.

---

## 1. How it fits together

```
incident ends
   ├─ severity from the trigger table            §2, lib/postmortems.ts
   ├─ issue from the form  ──────────────────→   9 sections + 8 structured fields
   │     label: postmortem                       (the query "have we seen this")
   └─ review within 5 or 10 business days
         └─ blameless review checklist           §7, 10 questions
               └─ action items, one per line, at least one a `detect`
                     └─ corrections to lib/runbooks.ts, an alarm, a guardrail
```

An issue form rather than a markdown template, and rather than a page in a wiki.
A markdown template is a set of headings the author is free to delete, and the
ones deleted under time pressure are reliably [What went
well](#what-went-well) and [Where we got lucky](#where-we-got-lucky). A form can
mark a field required, which is the only mechanism in reach that stops a
postmortem being filed without a timeline.

The label is load-bearing rather than decoration. "Have we seen this contributing
factor before" is answerable only if the postmortems are one query, and an issue
whose label was left to the author is not in it.

---

## 2. Which incidents owe one

Severity is read off the incident, not off how it felt. Any one trigger in a row
puts the incident at that severity.

| Severity | Triggers | Owes | Due |
| --- | --- | --- | --- |
| **Sev1** | A synthetic canary quorum alarm paged; **or** one incident spent ≥ 25% of an objective's error budget for its window; **or** data was lost or personal data left the systems allowed to hold it; **or** recovery needed a change nobody had rehearsed. | Full write-up and a review | 5 business days |
| **Sev2** | A paging alarm fired and a human changed something to clear it; **or** one incident spent 5–25% of an objective's error budget; **or** the database or cache was degraded in a way users could measure. | Full write-up and a review | 10 business days |
| **Sev3** | A ticket-severity alarm fired; **or** a page cleared itself before anyone acted; **or** a near miss — one failure away from a Sev2, and that failure did not happen. | A record: the issue, the severity, the structured fields | — |

Three things about that table are deliberate.

**Every runbook is in a row.** All eight entries in `RUNBOOK_CATALOGUE` are
named by one of the three severities, so an alarm that reached a human through
[docs/runbooks.md](./runbooks.md) has already been classified by the time it
clears. The gate checks that in both directions: a renamed runbook id leaves a
row classifying nothing, and a runbook no row names is the default state of
every runbook added after this file, since adding one touches neither the
process nor the form.

**The budget triggers name one objective.** `production-api-availability`, which
is `active` in `lib/slo-definitions.ts` and therefore measured.
`production-api-latency` is `proposed` for the reason
[docs/slo.md §5](./slo.md#5-wiring-a-latency-sli) gives — ALB publishes no count
of requests under a threshold, so there is no ratio to compute — and a trigger
keyed to it could never fire while reading exactly like one that can. The gate
rejects a budget trigger keyed to an objective that is missing or `proposed`.

**Sev3 still records something.** It owes no narrative, but it owes the issue,
the severity and the structured fields, because "is this the third time this
month?" is unanswerable otherwise — and that question is the only reason a
severity below the paging ones is in the table at all. A near miss is
deliberately a Sev3 rather than nothing: it is the cheapest incident there is and
it has the same contributing factors as the Sev1 it nearly was.

**The deadlines are dates, not intentions.** The document is written from memory,
the memory is gone in a fortnight, and a review with no date is scheduled after
the next incident. The gate refuses a severity that owes a write-up with no
deadline, and refuses a more severe row with a later one than the row below it.

---

## 3. Blameless is a property of the document

Not a promise made at the start of the meeting. A meeting can be blameless and
produce a document whose timeline reads "02:41 — the on-call engineer restarted
the wrong service", and that sentence is what gets read a year later by someone
deciding whether to be candid in their own write-up.

So the template does the work, in four specific ways.

**It never asks who.** There is no field for it. The timeline asks what happened,
what a signal showed, what was known at that moment, and what was believed —
including the beliefs that turned out to be wrong, because the gap between what
was known and what was true *is* the analysis.

**It asks for contributing factors, plural.** "Root cause" asks for one, so the
analysis stops at the first plausible answer, and the first plausible answer is
reliably the last action anyone took. The section asks, for each factor, what
made the wrong thing look correct at the time — which is the part that can be
changed. The action itself cannot.

**It refuses six phrases outright.** `BLAME_LANGUAGE` in `lib/postmortems.ts`,
enforced by the gate over the section prompts and over every label, description
and placeholder in the issue form: `human error`, `root cause`, `who caused` and
its variants, `should have known` and its variants, `failed to follow`, and
`negligent`. Each carries the question to ask instead, because a gate that says
"blame language found" gets worked around and one that says what to ask instead
gets used.

The scan is deliberately scoped to the prompts and the form rather than to this
document. This page has to be able to explain why "root cause" is not the
question it asks, and a rule that could not tell the explanation from the
instance would make the documentation unwritable — which is how a rule like this
gets suppressed and then deleted. The review checklist is exempt for the same
reason: two of its questions have to quote the language they are looking for.

**It asks how we found out, with "a customer told us" on the list.** A form whose
detection options are all machines makes the true answer unselectable, so the
author picks the nearest signal, and the one number worth having out of the whole
document is wrong in the reassuring direction. The gate refuses a detection list
with no human option — and one with no automated option, since then
time-to-detect has nothing to measure against.

---

## 4. The template, section by section

Nine sections. Eight are required; the last is the only optional one, and the
gate checks that in both directions — a required section whose field is optional
gets skipped on the night it matters, and an optional section whose field is
required cannot be submitted honestly for the first incident of its kind, which
teaches people to type "n/a".

### Summary

What broke, for whom, for how long, and what has changed since. Three sentences,
written for somebody who was not there and has thirty seconds. Written last.

### Impact

What users could not do, measured in requests, sessions or error-budget minutes
rather than in CPU percent. If a number is unknown, say that it is unknown and
why: an estimate that reads like a measurement is worse than a gap, because the
gap is a finding about the telemetry and the estimate is a fact nobody can check.

### Detection

Which signal fired first, how long after the impact started, and what the alert
carried. If a runbook was reached, whether its first step answered the question
it exists to answer — that is the only moment anyone can tell, and
[docs/runbooks.md](./runbooks.md) is where the correction goes.

### Timeline

One line per observable event, in UTC. What happened, what a signal showed, what
was known at that moment, and what was believed. Keep the beliefs that turned out
to be wrong; delete the names.

### Contributing factors

Each condition without which this incident would not have happened, and for each
one, what made the wrong thing look correct at the time. Expect several. An
incident with exactly one is an analysis that stopped early — and the giveaway is
that the one factor is usually the most recent human action, which is the least
interesting thing in the timeline.

### What went well

Which safeguard, signal or habit shortened this. Required, because these are
exactly the things a cost review removes when nobody has written down what they
bought. The tail-sampling tier, the canary fleet and the burn-rate policies all
cost money every month and pay off only here.

### Where we got lucky

What would have made this materially worse and did not happen this time. Every
incident has one — the deploy that had not gone out yet, the batch job that runs
at 06:00 and not 02:00, the region that was quiet. A blank answer means nobody
looked, and luck is a safeguard that happened to hold. The next incident is where
it does not.

### Action items

One line each: `[class] owning team — what changes — tracking issue`. Class is
one of `prevent`, `detect`, `mitigate` or `process`.

At least one has to be a `detect`. Prevention items are the ones that write
themselves at the end of a review and they are all predicated on the next
incident resembling this one; the detection item is the one that pays off when it
does not. An owning team rather than a person, for the same reason a runbook has
one: it outlives anyone's time on a rota. A tracking issue, because an action
item with no issue is a sentence in a document nobody opens again.

### Related incidents

Earlier postmortems sharing a contributing factor with this one, by issue number.
The only optional section, and the reason the label in §1 is load-bearing.

---

## 5. What makes an action item real

Four properties, checked by the review rather than by the gate — this is the part
that needs a person.

- **It changes the system.** "Be more careful" and "add training" are not
  changes: neither can be reviewed, tested or deployed. If the only available
  action is care, the gap is a missing guardrail and *that* is the item.
- **It has a class, and the set includes a `detect`.** See above.
- **It has an owning team and a tracking issue number.** Both in the line.
- **It is smaller than the incident.** An action item that reads "redesign the
  connection-pooling strategy" is a project, and projects do not get done because
  they appeared in a postmortem. Split it: the alarm this week, the redesign in
  the plan.

---

## 6. Where the facts go

Eight structured fields, separate from the narrative, because a sentence in a
summary cannot answer "what is our median time to detect, and is it going down".

| Field | Required | Why it is structured |
| --- | --- | --- |
| `incident-id` | yes | However it was referred to while it was running, so the thread and the write-up join up. |
| `severity` | yes | A dropdown over the §2 rows, so an incident cannot be filed at a severity the trigger table has no row for. |
| `owning-team` | yes | A team, never an individual. |
| `started-at` | yes | When users were first affected — usually earlier than when a signal fired. |
| `resolved-at` | yes | When users stopped being affected, not when the ticket was closed. |
| `detection-source` | yes | A dropdown including three human answers, for the reason §3 gives. |
| `time-to-detect` | yes | The number every alarm, canary and burn-rate policy in this repository exists to move. Read off an alarm history, not remembered. |
| `budget-spent` | no | From `ErrorBudgetRemainingPercent` before and after — see [docs/slo.md](./slo.md). Optional, because not every affected path is covered by an objective. |

`started-at` and `time-to-detect` are separate on purpose. The difference between
them is the only measurement in the document that the rest of this repository can
actually improve, and deriving it from a timeline written in prose is how it
never gets derived.

---

## 7. The blameless review checklist

Asked of the document, in the review, by whoever is chairing it. Each line is a
checkbox on the issue form, and every one is worded so that a tick is the good
answer.

1. **Is the document free of individual names outside the attendee list?**
   A name in a timeline turns a systems review into a performance review. The
   cost is not unfairness — it is that everyone who reads it afterwards edits
   their own answers, and the document stops recording what was actually known at
   the time.

2. **Is the document free of counterfactuals — "if only X had checked", "they
   should have noticed"?**
   A counterfactual describes a world that did not happen, so nothing in it can
   be built, measured or deployed. It is blame with the grammar of analysis, and
   it occupies the space where an action item would have gone.

3. **Are there at least two contributing factors, each with what made it look
   correct?**
   One cause means the analysis stopped at the first thing that looked wrong. The
   condition that made a wrong action the reasonable one is the part that can be
   changed; the action itself is not.

4. **Is time-to-detection a number, and does it come from a signal rather than a
   memory?**
   This is the number the alarms, canaries and burn-rate policies exist to move,
   and it is the one nobody writes down. "A customer told us" is a finding rather
   than an embarrassment: it is the finding that changes what gets built next.

5. **Is there something concrete in "Where we got lucky"?**
   A blank answer means nobody looked. Luck is a safeguard that happened to hold,
   and the next incident is where it does not.

6. **Does every action item name an owning team, a class, and a tracking issue?**
   An action item with no issue is a sentence in a document nobody opens again.
   An owner who is a person rather than a team expires when they change rota.

7. **Is at least one action item a detect?**
   Prevention items are the easy ones to write and they all assume the next
   incident looks like this one. Detection is what holds when it does not.

8. **Is every action item a change to the system, rather than "be more careful"
   or "add training"?**
   Neither is a change to the system, so neither can be reviewed, tested or
   deployed. If the only available action is care, the gap is a missing guardrail
   and that is the item.

9. **If a runbook was used, did it work — and has it been corrected?**
   The gap between what the runbook said and what actually helped is free to
   collect for a few days after an incident and impossible afterwards.
   `lib/runbooks.ts` is where the correction goes.

10. **Did every alarm that fired deserve to, and did every one that should have
    fire?**
    An alarm that fired and told the responder nothing is noise that will be
    ignored during the next incident. An alarm that stayed green through this one
    is the more expensive finding, and the only chance to notice it is now.

The questions are stored once, in `BLAMELESS_REVIEW_CHECKLIST`, and the gate
holds this list and the form's checkboxes to them character for character.
Paraphrasing is how a checklist item in the form stops matching the paragraph
that explains why it is there.

---

## 8. Adding a section or a checklist item

Edit `aws/cdk/lib/postmortems.ts` first — it is the declaration, and the other
two files are checked against it.

1. Add the entry: a `PostmortemSection` (with its `heading`, `formFieldId` and
   `required`), a `PostmortemMetadataField`, or a `BlamelessChecklistItem`.
2. Add the matching heading and paragraph here, under §4, §6 or §7. The heading
   text has to match `heading` exactly; this document numbers its own `##`
   headings and the sections are `###`, so the anchor stays stable.
3. Add the field to `.github/ISSUE_TEMPLATE/postmortem.yml` with the same `id`
   and the same `validations.required`.
4. `npm run audit:postmortems`. It will tell you which of the three you missed.

A section removed from the process has to be removed from all three as well: a
form field nothing declares is a box people fill in with a guess, and the guesses
differ per author, so the field ends up populated and unusable.

---

## 9. The failures, and what each one looks like

| What is wrong | What you would see | Rule |
| --- | --- | --- |
| Section added to the process, not to the form | Postmortems that read complete and are missing a section nobody asked for | `section-field-missing` |
| Field in the form nothing declares | Populated, inconsistent, unusable | `form-field-undeclared` |
| Required section, optional field | Holds until the first write-up typed at 23:00 | `field-requirement-mismatch` |
| Optional section, required field | The first incident of its kind cannot be filed honestly | `field-requirement-mismatch` |
| Dropdown drifted from its list | An incident filed at a severity §2 has no row for | `dropdown-options-mismatch` |
| A timeline collected as a single-line input | One-sentence timelines, because that is what fits | `field-kind-mismatch` |
| "What was the root cause?" in a well-meant edit | One cause per incident, and the analysis stops | `blame-language-in-form` |
| Checklist paraphrased in the form | The review asks a question the doc does not explain | `checklist-options-mismatch` |
| Checklist item with no paragraph here | Ticked without being applied | `checklist-question-not-in-doc` |
| Label dropped from the form | "Have we seen this before" stops being one query | `issue-form-label-missing` |
| A renamed runbook id in a severity | The row silently stops classifying anything | `runbook-reference-unknown` |
| A runbook no severity names | The alarm pages, the runbook answers it, and nothing says a write-up is owed | `runbook-without-severity` |
| A budget trigger on a `proposed` objective | A trigger that can never fire and reads like one that can | `budget-objective-not-active` |
| A renamed heading here | Every link to it lands at the top of the page, 200 OK | `doc-anchor-missing` / `section-heading-missing` |
| Nothing links this from the runbooks | The responder never opens the process; both documents look fine | `cross-link-missing` |

Plus every rule in `validatePostmortemProcess`, which is what can be decided
from `lib/postmortems.ts` alone: an unordered deadline, a severity that records
nothing, a checklist item with no reason, two dropdowns over one list, a blame
pattern carrying the `g` flag (a shared global RegExp keeps its `lastIndex`
between calls, so the same prompt is rejected on one run and accepted on the
next).

---

## 10. Known gaps

- **No incident has been written up with this.** The template, the triggers and
  the checklist are all reasoned from the failure modes above and from what the
  rest of this repository can measure; none of it has survived a real 04:00 yet.
  The example timeline in the form is illustrative and says so.
- **The gate checks the form, never a filled-in postmortem.** An issue whose
  action items have no owners passes everything here, because nothing reads
  issues. A bot that checked filed postmortems against §5 and §7 is the natural
  next item, and it needs a token and a repository, which CI on a fork's pull
  request does not have.
- **The severity triggers are not evaluated automatically.** They are facts about
  an incident that somebody reads off an alarm history and a budget metric. The
  `ErrorBudgetRemainingPercent` reading needed for the 25% and 5% triggers exists
  (docs/slo.md §8) but nothing diffs it across an incident window, so the
  percentage in `budget-spent` is typed in.
- **`time-to-detect` is self-reported.** It is checkable against an alarm history
  and nothing checks it.
- **Nothing tracks whether action items get done.** The tracking issue is in the
  line; closing the loop is the same missing bot as above.
- **No relationship to the DORA metrics already collected.** `DoraMetricsStack`
  records change-failure rate and time to restore, and an incident recorded here
  is the same event seen from the other side. Joining them would make "did the
  action items work" answerable from data rather than from memory, and neither
  side currently carries the other's identifier.
