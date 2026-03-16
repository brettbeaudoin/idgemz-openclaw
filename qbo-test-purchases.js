// Test script: list recent purchases (posted expenses) from QuickBooks Online
// Usage:
//   node qbo-test-purchases.js

const { getValidAccessToken, qboQuery } = require('./qbo-client');

(async () => {
  const { accessToken, realmId } = await getValidAccessToken();

  // Purchases represent expenses/charges; this should surface most bank/CC purchases once in the ledger.
  const query = "select Id, TxnDate, TotalAmt, PaymentType, AccountRef, EntityRef, PrivateNote, MetaData from Purchase order by MetaData.CreateTime desc maxresults 20";
  const { json, intuit_tid } = await qboQuery({ realmId, accessToken, query });

  const purchases = json?.QueryResponse?.Purchase || [];
  console.log('intuit_tid:', intuit_tid || 'n/a');
  console.log('count:', purchases.length);

  for (const p of purchases) {
    console.log(
      `${p.TxnDate || ''}  $${p.TotalAmt ?? ''}  id=${p.Id}  type=${p.PaymentType || ''}`
    );
  }
})();
