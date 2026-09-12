import { createUniqueId, type ComponentProps } from "solid-js"

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 129"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.6">
        <g mask={`url(#${mask})`}>
          <g opacity="0.16">
            <path
              opacity="0.7"
              d="M0 18H38V55H74V37H111V18H148V37H111V55H74V74H111V92H148V110H111V92H74V74H38V110H0V18Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M176 18H336V110H176V18ZM220 40V88H292V40H220Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M364 18H524V110H364V18ZM408 40V88H480V40H408Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M552 18H720V110H682V78H590V110H552V18ZM590 40V60H682V40H590Z"
              fill="currentColor"
            />
          </g>
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="720" height="129">
          <rect width="720" height="129" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="360" y1="68" x2="360" y2="129" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
