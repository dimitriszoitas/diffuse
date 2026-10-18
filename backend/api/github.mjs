import {createGitHubHandler} from '../github-http.mjs';
import {getGitHubServices,githubAllowedExtensionIds,githubRateLimit,githubConfigured} from '../github-runtime.mjs';
export default createGitHubHandler({getServices:getGitHubServices,allowedExtensionIds:githubAllowedExtensionIds,rateLimit:githubRateLimit,configured:githubConfigured});
