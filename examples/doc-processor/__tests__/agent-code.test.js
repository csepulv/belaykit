import { makeCodeProcessor } from '../src/agent-code.js';
import { describeProcessor } from './processor-contract.js';

describeProcessor('code', makeCodeProcessor);
