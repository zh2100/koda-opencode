export * as RelayEvent from "./relay-event"

import { Event } from "./event"

export const CatalogUpdated = Event.define({
  type: "relay.catalog.updated",
  schema: {},
})

export const Definitions = Event.inventory(CatalogUpdated)
