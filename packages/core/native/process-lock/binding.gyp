{
  "targets": [
    {
      "target_name": "process-lock",
      "sources": [
        "binding.cc"
      ],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "msvs_settings": {
        "VCLinkerTool": {
          "DelayLoadDLLs": ["node.exe"],
          "AdditionalOptions": ["/DELAYLOAD:node.exe"]
        }
      },
      "conditions": [
        ["OS=='win'", {
          "libraries": ["-lkernel32", "-ldelayimp"]
        }]
      ]
    }
  ]
}
