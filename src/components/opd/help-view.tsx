"use client";
import { Card } from "@/components/ui/card";
import { Breadcrumb } from "@/components/opd/breadcrumb";
import { AppFrame, PageHead } from "@/components/opd/app-frame";

const FAQ: { q: string; a: string }[] = [
  { q: "How do I get an account?", a: "Accounts are created by a super admin. Ask them for one email and password; the same pair works for every site and module you are allowed to use." },
  { q: "A module is greyed out. Why?", a: "The portal tried your email and password on that project and found no account, no profile, a disabled account, or the server did not answer. 'No account here' can also mean your password differs in that one project. Ask your admin, or sign in again later if it says Unreachable." },
  { q: "Can I enter exploration data without internet?", a: "Yes. Data is saved on your phone first and sent when you are online (the header chip shows how many records are waiting). Dashboard, Data QC, map tiles and 3D need internet." },
  { q: "What if I have no account yet in the field?", a: "Use 'Input tanpa login' in Exploration. Records stay on the phone and are sent after your next normal sign-in." },
  { q: "iPhone: anything special?", a: "iOS cannot sync in the background, and Safari may clear site data after about 7 days without use. Sync before a long break." },
  { q: "What do the roles mean?", a: "Viewer: read only. Data entry: can input. Site admin: can input and edit master data. Super admin: also manages users." },
  { q: "What happens when I sign out?", a: "You are signed out of every project on this device only. Cached server data is removed from the phone; records still waiting to be sent are kept." },
  { q: "Where do I report a problem?", a: "Tell your site admin first. For something the portal itself does wrong, send the page, what you tapped and the time to the OPD owner." },
];

export const HelpView = () => (
  <AppFrame active="help">{() => (
    <>
      <Breadcrumb className="mb-4" items={[{ label: "Home", href: "/" }, { label: "Help" }]} />
      <PageHead title="Help" lead="Contacts, and sign-in, access, offline use and roles in plain terms." />
      <div className="mb-6 grid gap-3 sm:grid-cols-2" data-contacts>
        <Card className="gap-1 p-4"><h2 className="text-base font-semibold">Accounts and access</h2><p className="text-sm text-muted-foreground">Ask a super admin to create your account or to add you to a site. Your site admin can tell you who that is.</p></Card>
        <Card className="gap-1 p-4"><h2 className="text-base font-semibold">Problems with the portal</h2><p className="text-sm text-muted-foreground">Tell your site admin first. If the portal itself is at fault, send the page, what you tapped and the time to the OPD owner.</p></Card>
      </div>
      <h2 className="mb-3 font-serif text-xl font-medium">FAQ</h2>
      <Card className="gap-0 divide-y p-0" data-faq>
        {FAQ.map(({ q, a }) => (
          <details key={q} className="group px-4 py-3">
            <summary className="nudge cursor-pointer list-none text-sm font-medium marker:hidden [&::-webkit-details-marker]:hidden">{q}</summary>
            <p className="mt-2 text-sm text-muted-foreground">{a}</p>
          </details>
        ))}
      </Card>
    </>
  )}</AppFrame>
);
