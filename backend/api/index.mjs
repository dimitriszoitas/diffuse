import {createHttpHandler} from '../http.mjs';
import {getServices, rateLimit, allowedExtensionIds} from '../runtime.mjs';

export default createHttpHandler({getServices, rateLimit, allowedExtensionIds});
