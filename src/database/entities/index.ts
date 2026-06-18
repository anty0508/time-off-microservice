import { Balance } from './balance.entity';
import { BalanceLedger } from './balance-ledger.entity';
import { HcmOutbox } from './hcm-outbox.entity';
import { TimeOffRequest } from './time-off-request.entity';

export { Balance } from './balance.entity';
export { BalanceLedger } from './balance-ledger.entity';
export { HcmOutbox } from './hcm-outbox.entity';
export { TimeOffRequest } from './time-off-request.entity';

/** All entities, for TypeOrmModule registration. */
export const ENTITIES = [Balance, BalanceLedger, HcmOutbox, TimeOffRequest];
