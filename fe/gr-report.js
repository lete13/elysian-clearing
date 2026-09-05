'use strict';
// Loaded by index.html (fe/patches-144.json). Plain script: the functions and
// MONTHS_GR land in the page's global scope; MONTHS comes from index.html.
// -- Greek clearing report (Configuration -> Language = GR) --
// The on-screen report and the PDF template are written in English; when the
// apartment's language is GR the finished HTML is passed through this
// dictionary so the owner's PDF, the email preview and the screen agree.
// Anchored on markup (">Label<", "<span>- Label</span>") so guest names,
// supplier names and free-text labels are never touched.
const MONTHS_GR = ['Ιανουάριος','Φεβρουάριος','Μάρτιος','Απρίλιος','Μάιος','Ιούνιος','Ιούλιος','Αύγουστος','Σεπτέμβριος','Οκτώβριος','Νοέμβριος','Δεκέμβριος'];
function _grPeriod(lbl) {
  return String(lbl == null ? '' : lbl).replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b(?=\s+\d{4})/g,
    (m0) => MONTHS_GR[MONTHS.indexOf(m0)] || m0);
}
const _GR_REPORT_DICT = [
  // period + header
  [/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b(?=\s+\d{4})/g, (m0) => MONTHS_GR[MONTHS.indexOf(m0)] || m0],
  ['Elysian Properties — Clearing Report', 'Elysian Properties — Μηνιαία Εκκαθάριση'],
  ['Elysian Property Management · Clearing Report', 'Elysian Property Management · Μηνιαία Εκκαθάριση'],
  ['>Elysian Clearing Report<', '>Μηνιαία Εκκαθάριση<'],
  ['Generated: ', 'Ημερομηνία έκδοσης: '],
  [' · Generated ', ' · Εκδόθηκε '],
  // KPI strip (PDF + screen)
  ['>Reservations<', '>Κρατήσεις<'],
  ['>Nights<', '>Διανυκτερεύσεις<'],
  ['>Gross revenue<', '>Ακαθάριστα Έσοδα<'],
  ['>before taxes &amp; fees<', '>προ φόρων &amp; προμηθειών<'],
  ['>Net payout<', '>Καθαρή Εκταμίευση<'],
  ['>from platform<', '>από την πλατφόρμα<'],
  [/% occupancy \((\d+)-day period\)/g, '% πληρότητα (περίοδος $1 ημερών)'],
  [/% occupancy/g, '% πληρότητα'],
  // section titles
  ['Revenue &amp; Deductions', 'Έσοδα &amp; Κρατήσεις'],
  ['Tax Breakdown &amp; Remittance', 'Ανάλυση Φόρων &amp; Απόδοση'],
  ['Elysian Fees &amp; Charges', 'Αμοιβές &amp; Χρεώσεις Elysian'],
  ['Expenses Charged (', 'Έξοδα ('],
  ['Expenses breakdown (', 'Ανάλυση εξόδων ('],
  ['>Summary<', '>Σύνοψη<'],
  [/Reservations — (\d+) bookings · (\d+) nights/g, 'Κρατήσεις — $1 κρατήσεις · $2 διανυκτερεύσεις'],
  [/(\d+) bookings · (\d+) nights/g, '$1 κρατήσεις · $2 διανυκτερεύσεις'],
  [/(\d+) maintenance blocks? excluded/g, '$1 block/maintenance εξαιρέθηκαν'],
  ['Notes for this period · Σημειώσεις περιόδου', 'Σημειώσεις περιόδου'],
  // revenue & deductions rows
  ['<span>Total guest value</span>', '<span>Συνολική αξία κράτησης</span>'],
  ['<span>- Climate / stayover tax</span>', '<span>- Τέλος ανθεκτικότητας (ΤΑΚΚ)</span>'],
  ['<span>- VAT on accommodation</span>', '<span>- ΦΠΑ διαμονής</span>'],
  ['<span>- Accommodation tax</span>', '<span>- Φόρος διαμονής</span>'],
  ['<span>- Service fee (host)</span>', '<span>- Προμήθεια πλατφόρμας</span>'],
  ['<span>- Payment charges</span>', '<span>- Έξοδα πληρωμών</span>'],
  ['<span>Net payout from platform</span>', '<span>Καθαρή εκταμίευση από πλατφόρμα</span>'],
  ['Subtotal — taxes &amp; platform', 'Σύνολο φόρων &amp; προμηθειών'],
  ['Subtotal — Elysian charges, excl. mgmt fee', 'Σύνολο χρεώσεων Elysian, εκτός αμοιβής διαχείρισης'],
  [' (incl. VAT)', ' (με ΦΠΑ)'],
  [' incl. 24% VAT', ' με ΦΠΑ 24%'],
  ['>Net Earnings<', '>Καθαρά Έσοδα<'],
  ['>after all deductions<', '>μετά από όλες τις κρατήσεις<'],
  ['<span>Management fee base</span>', '<span>Βάση αμοιβής διαχείρισης</span>'],
  ['Management fee (', 'Αμοιβή διαχείρισης ('],
  ['B2B Partner Remittance (net + ', 'Απόδοση Συνεργάτη B2B (καθαρό + '],
  [' + Mun.tax ', ' + Δημ. φόρος '],
  ['>Remittance to Owner<', '>Ποσό Απόδοσης Ιδιοκτήτη<'],
  ['>Remittance Amount<', '>Ποσό Απόδοσης<'],
  // fees table / fee rows
  [/(>|- )Cleaning fee\b/g, '$1Καθαρισμός'],
  [/(\d+) stays × ([^<]+?)\/stay/g, '$1 διαμονές × $2/διαμονή'],
  [/(\d+) stays across (\d+) properties/g, '$1 διαμονές σε $2 ακίνητα'],
  [/× (\d+) months?\b/g, '× $1 μήνες'],
  ['Monthly charge × ', 'Μηνιαία χρέωση × '],
  ['Fixed charge', 'Πάγια χρέωση'],
  ['>Credit<', '>Πίστωση<'],
  ['>CREDIT<', '>ΠΙΣΤΩΣΗ<'],
  [' (split)', ' (επιμερισμός)'],
  ['service fee + payment charges', 'προμήθεια + έξοδα πληρωμών'],
  [/(\d+) items?</g, '$1 στοιχεία<'],
  ['No fees this period', 'Χωρίς χρεώσεις αυτή την περίοδο'],
  ['No expenses charged this period', 'Χωρίς έξοδα αυτή την περίοδο'],
  ['>None<', '>Καμία<'],
  // tax cards (PDF + screen)
  ['Climate / Stayover Tax', 'ΤΑΚΚ (Τέλος Ανθεκτικότητας)'],
  ['>Climate Tax (ΤΑΚΚ)<', '>ΤΑΚΚ<'],
  ['>VAT on Accommodation<', '>ΦΠΑ Διαμονής<'],
  ['>VAT (ΦΠΑ)<', '>ΦΠΑ<'],
  ['>Accommodation Tax<', '>Φόρος Διαμονής<'],
  ['Booking value pre-VAT: ', 'Αξία προ ΦΠΑ: '],
  ['Pre-VAT base: ', 'Βάση προ ΦΠΑ: '],
  ['>Total to remit<', '>Σύνολο προς απόδοση<'],
  ['✓ Handled by channel', '✓ Αποδίδεται από την πλατφόρμα'],
  ['✓ Owner/partner remits to authorities', '✓ Αποδίδεται από ιδιοκτήτη/συνεργάτη'],
  ['⚠ Elysian must remit to authorities', '⚠ Αποδίδεται από την Elysian'],
  ['Owner/Partner remits to authorities', 'Αποδίδει ο ιδιοκτήτης/συνεργάτης'],
  ['Owner/Partner remits', 'Αποδίδει ο ιδιοκτήτης/συνεργάτης'],
  ['Elysian remits', 'Αποδίδει η Elysian'],
  [' €/night', ' €/διαν.'],
  ['>Total expenses<', '>Σύνολο εξόδων<'],
  [/>Total \((\d+)\)</g, '>Σύνολο ($1)<'],
  [/(\d+) nights × ([^<]+?) €\/night/g, '$1 διανυκτερεύσεις × $2 €/διαν.'],
  [/(\d+) nights\b/g, '$1 διανυκτερεύσεις'],
  // table headers
  ['>Guest<', '>Επισκέπτης<'],
  ['>Check-in<', '>Άφιξη<'],
  ['>Check-out<', '>Αναχώρηση<'],
  ['>Nts<', '>Νύχτες<'],
  ['>Channel<', '>Κανάλι<'],
  ['>Booking<', '>Αξία κράτησης<'],
  ['>Clim. tax<', '>ΤΑΚΚ<'],
  ['>Clim.tax<', '>ΤΑΚΚ<'],
  ['>VAT<', '>ΦΠΑ<'],
  ['>Gross<', '>Ακαθάριστα<'],
  ['>Platf. fee<', '>Προμήθεια<'],
  ['>Pmt chg<', '>Έξ. πληρ.<'],
  ['>Fees<', '>Προμήθειες<'],
  ['>Fee<', '>Χρέωση<'],
  ['>Ex-VAT<', '>Προ ΦΠΑ<'],
  ['>VAT 24%<', '>ΦΠΑ 24%<'],
  ['>Total<', '>Σύνολο<'],
  ['>Payout<', '>Εκταμίευση<'],
  ['>Date<', '>Ημ/νία<'],
  ['>Supplier<', '>Προμηθευτής<'],
  ['>Description<', '>Περιγραφή<'],
];
function _grReportHtml(html) {
  let out = String(html == null ? '' : html);
  for (const [find, repl] of _GR_REPORT_DICT) {
    if (find instanceof RegExp) out = out.replace(find, repl);
    else out = out.split(find).join(repl);
  }
  return out;
}
