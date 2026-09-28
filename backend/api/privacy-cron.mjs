import {createPrivacyCronHandler} from '../privacy-cron.mjs';
import {getServices} from '../runtime.mjs';

export default createPrivacyCronHandler({
  secret: process.env.CRON_SECRET,
  run: () => getServices().privacy.run({maxAccounts: 90, maxRunMs: 45000})
});
