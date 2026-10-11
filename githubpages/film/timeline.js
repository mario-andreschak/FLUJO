// Only reviewed, genuine capture assets belong in the playable timeline.
// Click times are seconds in each reviewed source clip; coordinates come from
// that clip's capture manifest. Pointer travel and its neutral initial pose
// are editorial guidance, not a claim of measured native cursor motion.
export const FILM = Object.freeze({
  "title": "Build a website with FLUJO",
  "stage": "final",
  "stageLabel": "Reviewed guided walkthrough",
  "exportReady": true,
  "downloadReady": true,
  "exportFilename": "flujo-guided-walkthrough.mp4",
  "width": 1600,
  "height": 1000,
  "fps": 30,
  "reviewTimes": [
    2,
    9,
    19.7,
    24,
    40.7,
    46,
    53,
    63.7,
    69,
    91.0,
    110.5,
    137.9,
    152.35,
    175.3,
    204.3,
    216.8,
    232,
    251,
    262,
    277,
    289,
    311,
    334,
    339,
    358,
    381,
    395,
    411,
    437,
    449,
    473.4,
    482.3,
    488.3,
    493,
    503,
    515,
    527,
    537,
    548.5,
    558,
    567,
    586,
    601,
    611,
    622,
    631,
    642,
    653,
    662,
    673,
    685,
    702,
    714,
    724,
    735,
    742,
    757,
    765,
    776,
    784,
    790,
    797,
    810,
    824,
    835,
    865,
    875,
    883,
    892,
    904,
    915,
    930,
    948,
    967,
    984,
    1010,
    1035,
    1041,
    1056,
    1070.3,
    1080.3,
    1094.3,
    1113.3,
    1119.3,
    1128.3,
    1137.3,
    1146.3,
    1155.3,
    1164.3,
    1175.3
  ],
  "gentleReviewTime": 2
});

const plan = [
  {
    "id": "dashboard-anchor",
    "chapter": "dashboard",
    "type": "footage",
    "source": "opening",
    "sourceStart": 0,
    "sourceEnd": 3,
    "duration": 5,
    "holdTail": 2,
    "stillTime": 2,
    "initialPointer": {
      "x": 160,
      "y": 180
    }
  },
  {
    "id": "why-builder",
    "chapter": "dashboard",
    "type": "narration",
    "duration": 10,
    "title": "Build a reusable website assistant",
    "text": "First, connect the AI that will read your brief and use its tools."
  },
  {
    "id": "open-ai-setup",
    "chapter": "ai-setup",
    "type": "footage",
    "source": "opening",
    "sourceStart": 3,
    "sourceEnd": 10,
    "holdLead": 4,
    "duration": 11,
    "stillTime": 8,
    "initialPointer": {
      "x": 160,
      "y": 180
    },
    "events": [
      {
        "at": 4.27,
        "x": 293,
        "y": 36,
        "type": "click",
        "actionId": "act1-action-01",
        "travelSeconds": 1.2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 5.5,
        "rect": [
          240,
          16,
          105,
          41
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          240,
          16,
          105,
          41
        ],
        "zoom": 2.6
      },
      {
        "at": 5.27,
        "focus": [
          240,
          16,
          105,
          41
        ],
        "zoom": 2.6
      },
      {
        "at": 6.27
      },
      {
        "at": 11
      }
    ]
  },
  {
    "id": "why-connection",
    "chapter": "ai-setup",
    "type": "narration",
    "duration": 8,
    "title": "Add your AI connection",
    "text": "This example uses Gemini through OpenRouter."
  },
  {
    "id": "open-connect-ai",
    "chapter": "ai-setup",
    "type": "footage",
    "source": "opening",
    "sourceStart": 10,
    "sourceEnd": 22,
    "holdLead": 3,
    "duration": 15,
    "stillTime": 19,
    "initialPointer": {
      "x": 293,
      "y": 36
    },
    "events": [
      {
        "at": 14.22,
        "x": 1444,
        "y": 306,
        "type": "click",
        "actionId": "act1-action-02",
        "travelSeconds": 4
      }
    ],
    "highlights": [
      {
        "start": 3,
        "end": 7.6,
        "rect": [
          1376,
          286,
          131,
          41
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 4.5
      },
      {
        "at": 5.7,
        "focus": [
          1376,
          286,
          131,
          41
        ],
        "zoom": 2.6
      },
      {
        "at": 7.22,
        "focus": [
          1376,
          286,
          131,
          41
        ],
        "zoom": 2.6
      },
      {
        "at": 8.22
      },
      {
        "at": 15
      }
    ]
  },
  {
    "id": "why-direct-setup",
    "chapter": "ai-setup",
    "type": "narration",
    "duration": 8,
    "title": "Open the model settings",
    "text": "“I’m an expert” opens the settings directly."
  },
  {
    "id": "open-model-form",
    "chapter": "ai-setup",
    "type": "footage",
    "source": "opening",
    "sourceStart": 28,
    "sourceEnd": 42.9,
    "holdLead": 3,
    "duration": 17.9,
    "stillTime": 39,
    "initialPointer": {
      "x": 1444,
      "y": 306
    },
    "events": [
      {
        "at": 31.97,
        "x": 1066,
        "y": 518,
        "type": "click",
        "actionId": "act1-action-03",
        "travelSeconds": 3
      }
    ],
    "highlights": [
      {
        "start": 3,
        "end": 7.3,
        "rect": [
          940,
          434,
          267,
          166
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 4.5
      },
      {
        "at": 5.7,
        "focus": [
          940,
          434,
          267,
          166
        ],
        "zoom": 2.6
      },
      {
        "at": 6.97,
        "focus": [
          940,
          434,
          267,
          166
        ],
        "zoom": 2.6
      },
      {
        "at": 7.97
      },
      {
        "at": 17.9
      }
    ]
  },
  {
    "id": "why-configure",
    "chapter": "connect-model",
    "type": "narration",
    "duration": 8,
    "title": "Connect the model",
    "text": "Name this connection Website Builder AI. Choose OpenRouter and Gemini 3 Flash."
  },
  {
    "id": "name-connection",
    "chapter": "connect-model",
    "type": "footage",
    "source": "model-setup",
    "sourceStart": 0,
    "sourceEnd": 5.2,
    "holdLead": 4,
    "holdTail": 7,
    "duration": 16.2,
    "stillTime": 4,
    "initialPointer": {
      "x": 1066,
      "y": 518
    },
    "highlights": [
      {
        "start": 3,
        "end": 12.2,
        "rect": [
          65,
          156,
          701,
          60
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          65,
          156,
          701,
          60
        ],
        "zoom": 2.2
      },
      {
        "at": 12.2,
        "focus": [
          65,
          156,
          701,
          60
        ],
        "zoom": 2.2
      },
      {
        "at": 13.2
      },
      {
        "at": 16.2
      }
    ]
  },
  {
    "id": "choose-provider",
    "chapter": "connect-model",
    "type": "footage",
    "source": "model-setup",
    "sourceStart": 5.2,
    "sourceEnd": 18,
    "holdLead": 5,
    "holdTail": 5,
    "duration": 22.8,
    "stillTime": 16.5,
    "initialPointer": {
      "x": 1066,
      "y": 518
    },
    "events": [
      {
        "at": 5.373,
        "x": 416,
        "y": 278,
        "type": "click",
        "travelSeconds": 1.2
      },
      {
        "at": 13.497,
        "x": 169,
        "y": 416,
        "type": "click",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 3,
        "end": 5.65,
        "rect": [
          65,
          250,
          701,
          56
        ]
      },
      {
        "start": 7.5,
        "end": 13.55,
        "rect": [
          73,
          397,
          680,
          38
        ]
      },
      {
        "start": 14,
        "end": 18.8,
        "rect": [
          65,
          250,
          701,
          56
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          65,
          250,
          701,
          56
        ],
        "zoom": 2.2
      },
      {
        "at": 6.2,
        "focus": [
          65,
          250,
          701,
          56
        ],
        "zoom": 2.2
      },
      {
        "at": 7.5,
        "focus": [
          73,
          397,
          680,
          38
        ],
        "zoom": 2.2
      },
      {
        "at": 14.2,
        "focus": [
          73,
          397,
          680,
          38
        ],
        "zoom": 2.2
      },
      {
        "at": 15.4,
        "focus": [
          65,
          250,
          701,
          56
        ],
        "zoom": 2.2
      },
      {
        "at": 18.8,
        "focus": [
          65,
          250,
          701,
          56
        ],
        "zoom": 2.2
      },
      {
        "at": 19.8
      },
      {
        "at": 22.8
      }
    ]
  },
  {
    "id": "private-provider-key",
    "chapter": "connect-model",
    "type": "narration",
    "duration": 8,
    "title": "Connect your account",
    "text": "Provider key entered privately. The field remains masked."
  },
  {
    "id": "enter-model",
    "chapter": "connect-model",
    "type": "footage",
    "source": "model-setup",
    "sourceStart": 18,
    "sourceEnd": 25,
    "holdLead": 4,
    "holdTail": 5,
    "duration": 16,
    "stillTime": 23,
    "initialPointer": {
      "x": 169,
      "y": 416
    },
    "events": [
      {
        "at": 19.983,
        "x": 361,
        "y": 575,
        "type": "click",
        "travelSeconds": 1.5
      }
    ],
    "highlights": [
      {
        "start": 3,
        "end": 12,
        "rect": [
          65,
          547,
          701,
          56
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          65,
          547,
          701,
          56
        ],
        "zoom": 2.2
      },
      {
        "at": 12,
        "focus": [
          65,
          547,
          701,
          56
        ],
        "zoom": 2.2
      },
      {
        "at": 13
      },
      {
        "at": 16
      }
    ]
  },
  {
    "id": "save-connection",
    "chapter": "connect-model",
    "type": "footage",
    "source": "model-setup",
    "sourceStart": 25,
    "sourceEnd": 34.9,
    "holdLead": 3,
    "duration": 12.9,
    "stillTime": 33,
    "initialPointer": {
      "x": 361,
      "y": 575
    },
    "events": [
      {
        "at": 26.484,
        "x": 1093,
        "y": 131,
        "type": "click",
        "travelSeconds": 1.2
      },
      {
        "at": 29.03,
        "x": 1518,
        "y": 921,
        "type": "click",
        "travelSeconds": 2.5
      }
    ],
    "highlights": [
      {
        "start": 4.6,
        "end": 7.35,
        "rect": [
          1486,
          901,
          65,
          40
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 4.8
      },
      {
        "at": 6,
        "focus": [
          1486,
          901,
          65,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 7.03,
        "focus": [
          1486,
          901,
          65,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 8.03
      },
      {
        "at": 12.9
      }
    ]
  },
  {
    "id": "why-test",
    "chapter": "test-ai",
    "type": "narration",
    "duration": 8,
    "title": "Check before using it",
    "text": "Confirm that the model responds and can use FLUJO’s tools."
  },
  {
    "id": "test-connection",
    "chapter": "test-ai",
    "type": "footage",
    "source": "model-test",
    "sourceStart": 0,
    "sourceEnd": 14,
    "holdLead": 3,
    "duration": 17,
    "stillTime": 13,
    "initialPointer": {
      "x": 1518,
      "y": 921
    },
    "events": [
      {
        "at": 5.112,
        "x": 60,
        "y": 614,
        "type": "click",
        "travelSeconds": 5
      }
    ],
    "highlights": [
      {
        "start": 3,
        "end": 8.4,
        "rect": [
          45,
          596,
          30,
          36
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          45,
          596,
          30,
          36
        ],
        "zoom": 2.6
      },
      {
        "at": 8.112,
        "focus": [
          45,
          596,
          30,
          36
        ],
        "zoom": 2.6
      },
      {
        "at": 9.112
      },
      {
        "at": 17
      }
    ]
  },
  {
    "id": "why-passed",
    "chapter": "test-ai",
    "type": "narration",
    "duration": 8,
    "title": "The connection works",
    "text": "The model replied and used a FLUJO tool successfully."
  },
  {
    "id": "read-test-result",
    "chapter": "test-ai",
    "type": "footage",
    "source": "model-test",
    "sourceStart": 14,
    "sourceEnd": 24.9,
    "holdTail": 14.1,
    "duration": 25,
    "stillTime": 20,
    "initialPointer": {
      "x": 60,
      "y": 614
    },
    "highlights": [
      {
        "start": 3,
        "end": 12.2,
        "rect": [
          525,
          251,
          550,
          71
        ]
      },
      {
        "start": 13.4,
        "end": 20.8,
        "rect": [
          525,
          670,
          550,
          78
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          525,
          251,
          550,
          71
        ],
        "zoom": 2.5
      },
      {
        "at": 12.2,
        "focus": [
          525,
          251,
          550,
          71
        ],
        "zoom": 2.5
      },
      {
        "at": 13.4,
        "focus": [
          525,
          670,
          550,
          78
        ],
        "zoom": 2.5
      },
      {
        "at": 20.8,
        "focus": [
          525,
          670,
          550,
          78
        ],
        "zoom": 2.5
      },
      {
        "at": 21.8
      },
      {
        "at": 25
      }
    ]
  },
  {
    "id": "why-tool",
    "chapter": "connect-tool",
    "type": "narration",
    "duration": 9,
    "title": "Give the builder useful tools",
    "text": "Connect Desktop Commander to create files and run a local website."
  },
  {
    "id": "open-connect-app",
    "chapter": "connect-tool",
    "type": "footage",
    "source": "tool-import",
    "sourceStart": 0,
    "sourceEnd": 6,
    "duration": 11,
    "stillTime": 5.5,
    "holdLead": 4,
    "holdTail": 1,
    "initialPointer": {
      "x": 60,
      "y": 614
    },
    "events": [
      {
        "at": 2.264,
        "x": 1414,
        "y": 121,
        "type": "click",
        "actionId": "47-open-connect-app",
        "travelSeconds": 3
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.564,
        "rect": [
          1344,
          101,
          139,
          41
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          1344,
          101,
          139,
          41
        ],
        "zoom": 2.6
      },
      {
        "at": 6.264,
        "focus": [
          1344,
          101,
          139,
          41
        ],
        "zoom": 2.6
      },
      {
        "at": 7.264
      },
      {
        "at": 11
      }
    ]
  },
  {
    "id": "why-github",
    "chapter": "connect-tool",
    "type": "narration",
    "duration": 8,
    "title": "Use its GitHub link",
    "text": "The link tells FLUJO which tool to download."
  },
  {
    "id": "choose-connection-details",
    "chapter": "connect-tool",
    "type": "footage",
    "source": "tool-import",
    "sourceStart": 6,
    "sourceEnd": 12,
    "duration": 11,
    "stillTime": 11.5,
    "holdLead": 4,
    "holdTail": 1,
    "initialPointer": {
      "x": 1414,
      "y": 121
    },
    "events": [
      {
        "at": 8.51,
        "x": 1054,
        "y": 508,
        "type": "click",
        "actionId": "50-have-connection-details",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.81,
        "rect": [
          940,
          417,
          267,
          186
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          940,
          417,
          267,
          186
        ],
        "zoom": 2.6
      },
      {
        "at": 6.51,
        "focus": [
          940,
          417,
          267,
          186
        ],
        "zoom": 2.6
      },
      {
        "at": 7.51
      },
      {
        "at": 11
      }
    ]
  },
  {
    "id": "choose-github",
    "chapter": "connect-tool",
    "type": "footage",
    "source": "tool-import",
    "sourceStart": 12,
    "sourceEnd": 18,
    "duration": 11,
    "stillTime": 17.5,
    "holdLead": 4,
    "holdTail": 1,
    "initialPointer": {
      "x": 1054,
      "y": 508
    },
    "events": [
      {
        "at": 14.271,
        "x": 789,
        "y": 516,
        "type": "click",
        "actionId": "52-choose-github",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.571,
        "rect": [
          662,
          420,
          266,
          187
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          662,
          420,
          266,
          187
        ],
        "zoom": 2.6
      },
      {
        "at": 6.271,
        "focus": [
          662,
          420,
          266,
          187
        ],
        "zoom": 2.6
      },
      {
        "at": 7.271
      },
      {
        "at": 11
      }
    ]
  },
  {
    "id": "enter-tool-url",
    "chapter": "connect-tool",
    "type": "footage",
    "source": "tool-import",
    "sourceStart": 18,
    "sourceEnd": 24,
    "duration": 17,
    "stillTime": 22,
    "holdLead": 4,
    "holdTail": 7,
    "initialPointer": {
      "x": 789,
      "y": 516
    },
    "events": [
      {
        "at": 18.74,
        "x": 539,
        "y": 558,
        "type": "click",
        "actionId": "54-focus-github-url",
        "travelSeconds": 1.5
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 4.2,
        "rect": [
          65,
          537,
          1470,
          42
        ]
      },
      {
        "start": 4.2,
        "end": 13,
        "rect": [
          72,
          540,
          460,
          35
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          65,
          515,
          540,
          81
        ],
        "zoom": 2.2
      },
      {
        "at": 13,
        "focus": [
          65,
          515,
          540,
          81
        ],
        "zoom": 2.2
      },
      {
        "at": 14
      },
      {
        "at": 17
      }
    ]
  },
  {
    "id": "parse-tool-url",
    "chapter": "connect-tool",
    "type": "footage",
    "source": "tool-import",
    "sourceStart": 24,
    "sourceEnd": 30,
    "duration": 11,
    "stillTime": 29.5,
    "holdLead": 4,
    "holdTail": 1,
    "initialPointer": {
      "x": 539,
      "y": 558
    },
    "events": [
      {
        "at": 25.594,
        "x": 1492,
        "y": 631,
        "type": "click",
        "actionId": "57-parse-github-url",
        "travelSeconds": 2.5
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 5.894,
        "rect": [
          1451,
          611,
          84,
          40
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          1451,
          611,
          84,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 5.594,
        "focus": [
          1451,
          611,
          84,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 6.594
      },
      {
        "at": 11
      }
    ]
  },
  {
    "id": "why-install-tool",
    "chapter": "prepare-tool",
    "type": "narration",
    "duration": 10,
    "title": "Prepare the tool",
    "text": "FLUJO downloads and prepares the tool for use.",
    "label": "Download and installation waits shortened"
  },
  {
    "id": "clone-tool",
    "chapter": "prepare-tool",
    "type": "footage",
    "source": "tool-import",
    "sourceStart": 30,
    "sourceEnd": 38,
    "duration": 12,
    "stillTime": 37.5,
    "holdLead": 4,
    "initialPointer": {
      "x": 1492,
      "y": 631
    },
    "events": [
      {
        "at": 31.925,
        "x": 1450,
        "y": 674,
        "type": "click",
        "actionId": "59-clone-desktop-commander",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.225,
        "rect": [
          1376,
          653,
          159,
          40
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          1376,
          653,
          159,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 5.925,
        "focus": [
          1376,
          653,
          159,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 6.925
      },
      {
        "at": 12
      }
    ]
  },
  {
    "id": "tool-install-begins",
    "chapter": "prepare-tool",
    "type": "footage",
    "source": "tool-import",
    "sourceStart": 38,
    "sourceEnd": 43.9,
    "duration": 9.0,
    "stillTime": 43.5,
    "holdTail": 3.1,
    "initialPointer": {
      "x": 1450,
      "y": 674
    }
  },
  {
    "id": "inspect-install-settings",
    "chapter": "prepare-tool",
    "type": "footage",
    "source": "tool-install",
    "sourceStart": 0,
    "sourceEnd": 7,
    "duration": 21,
    "stillTime": 5,
    "holdLead": 4,
    "holdTail": 10,
    "initialPointer": {
      "x": 1450,
      "y": 674
    },
    "events": [
      {
        "at": 1.94,
        "x": 1009,
        "y": 282,
        "type": "click",
        "actionId": "63-open-install-build-settings",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.3,
        "rect": [
          65,
          247,
          969,
          59
        ]
      },
      {
        "start": 8.2,
        "end": 16.2,
        "rect": [
          90,
          310,
          580,
          282
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          65,
          247,
          969,
          59
        ],
        "zoom": 1.5
      },
      {
        "at": 5.94,
        "focus": [
          65,
          247,
          969,
          59
        ],
        "zoom": 1.5
      },
      {
        "at": 6.94
      },
      {
        "at": 8.2,
        "focus": [
          90,
          312,
          690,
          290
        ],
        "zoom": 2.0
      },
      {
        "at": 16.2,
        "focus": [
          90,
          312,
          690,
          290
        ],
        "zoom": 2.0
      },
      {
        "at": 17.2
      },
      {
        "at": 21
      }
    ]
  },
  {
    "id": "tool-install-and-build",
    "chapter": "prepare-tool",
    "type": "footage",
    "source": "tool-install",
    "sourceStart": 7,
    "sourceEnd": 24.9,
    "duration": 18.0,
    "stillTime": 20.7,
    "holdTail": 0.1,
    "initialPointer": {
      "x": 1009,
      "y": 282
    },
    "highlights": [
      {
        "start": 3,
        "end": 10,
        "rect": [
          65,
          387,
          970,
          418
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          65,
          387,
          970,
          418
        ],
        "zoom": 1.6
      },
      {
        "at": 10,
        "focus": [
          65,
          387,
          970,
          418
        ],
        "zoom": 1.6
      },
      {
        "at": 11
      },
      {
        "at": 18
      }
    ]
  },
  {
    "id": "why-local-launch",
    "chapter": "prepare-tool",
    "type": "narration",
    "duration": 10,
    "title": "Tell FLUJO how to start the tool",
    "text": "These settings let your agent use it whenever it needs to."
  },
  {
    "id": "read-node-command",
    "chapter": "prepare-tool",
    "type": "footage",
    "source": "tool-install",
    "sourceStart": 25,
    "sourceEnd": 25.5,
    "duration": 12.5,
    "stillTime": 25.2,
    "holdTail": 12,
    "initialPointer": {
      "x": 1009,
      "y": 282
    },
    "highlights": [
      {
        "start": 3,
        "end": 8.5,
        "rect": [
          90,
          144,
          918,
          66
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          90,
          144,
          918,
          66
        ],
        "zoom": 1.7
      },
      {
        "at": 8.5,
        "focus": [
          90,
          144,
          918,
          66
        ],
        "zoom": 1.7
      },
      {
        "at": 9.5
      },
      {
        "at": 12.5
      }
    ]
  },
  {
    "id": "set-local-entry",
    "chapter": "prepare-tool",
    "type": "footage",
    "source": "tool-install",
    "sourceStart": 25.5,
    "sourceEnd": 31,
    "duration": 16.0,
    "stillTime": 29,
    "holdLead": 4,
    "holdTail": 6.5,
    "initialPointer": {
      "x": 1009,
      "y": 282
    },
    "events": [
      {
        "at": 26.825,
        "x": 339,
        "y": 511,
        "type": "click",
        "actionId": "84-focus-local-entry-corrected",
        "travelSeconds": 1.5
      }
    ],
    "highlights": [
      {
        "start": 3,
        "end": 12,
        "rect": [
          90,
          492,
          829,
          42
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          90,
          492,
          829,
          42
        ],
        "zoom": 1.9
      },
      {
        "at": 12,
        "focus": [
          90,
          492,
          829,
          42
        ],
        "zoom": 1.9
      },
      {
        "at": 13
      },
      {
        "at": 16
      }
    ]
  },
  {
    "id": "set-no-onboarding",
    "chapter": "prepare-tool",
    "type": "footage",
    "source": "tool-install",
    "sourceStart": 31,
    "sourceEnd": 37,
    "duration": 16,
    "stillTime": 35,
    "holdLead": 4,
    "holdTail": 6,
    "initialPointer": {
      "x": 339,
      "y": 511
    },
    "events": [
      {
        "at": 32.398,
        "x": 451,
        "y": 563,
        "type": "click",
        "actionId": "87-focus-onboarding-option",
        "travelSeconds": 1.5
      }
    ],
    "highlights": [
      {
        "start": 3,
        "end": 12,
        "rect": [
          90,
          543,
          829,
          42
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          90,
          543,
          829,
          42
        ],
        "zoom": 1.9
      },
      {
        "at": 12,
        "focus": [
          90,
          543,
          829,
          42
        ],
        "zoom": 1.9
      },
      {
        "at": 13
      },
      {
        "at": 16
      }
    ]
  },
  {
    "id": "why-manual-test",
    "chapter": "test-tool",
    "type": "narration",
    "duration": 10,
    "title": "Check the tool connection",
    "text": "Manual setup uses the same tool. The folder is corrected; test again before saving."
  },
  {
    "id": "test-local-tool",
    "chapter": "test-tool",
    "type": "footage",
    "source": "tool-connected",
    "sourceStart": 5,
    "sourceEnd": 11.8,
    "duration": 13.0,
    "stillTime": 11.5,
    "holdLead": 4,
    "holdTail": 2.2,
    "initialPointer": {
      "x": 451,
      "y": 563
    },
    "events": [
      {
        "at": 7.017,
        "x": 954,
        "y": 613,
        "type": "click",
        "actionId": "133-test-corrected-path",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.35,
        "rect": [
          906,
          593,
          102,
          40
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          906,
          593,
          102,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 6.017,
        "focus": [
          906,
          593,
          102,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 7.017
      },
      {
        "at": 13
      }
    ]
  },
  {
    "id": "read-tool-test-result",
    "chapter": "test-tool",
    "type": "footage",
    "source": "tool-connected",
    "sourceStart": 11.8,
    "sourceEnd": 16,
    "duration": 16.0,
    "stillTime": 14,
    "holdTail": 11.8,
    "initialPointer": {
      "x": 954,
      "y": 613
    },
    "highlights": [
      {
        "start": 3,
        "end": 12,
        "rect": [
          1077,
          391,
          407,
          84
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          1077,
          391,
          407,
          84
        ],
        "zoom": 2.6
      },
      {
        "at": 12,
        "focus": [
          1077,
          391,
          407,
          84
        ],
        "zoom": 2.6
      },
      {
        "at": 13
      },
      {
        "at": 16
      }
    ]
  },
  {
    "id": "why-save-tool",
    "chapter": "test-tool",
    "type": "narration",
    "duration": 9,
    "title": "Save the tested connection",
    "text": "The test found 26 tools. Save this connection in your workspace."
  },
  {
    "id": "add-connected-tool",
    "chapter": "test-tool",
    "type": "footage",
    "source": "tool-connected",
    "sourceStart": 16,
    "sourceEnd": 27.9,
    "duration": 21.0,
    "stillTime": 26,
    "holdLead": 4,
    "holdTail": 5.1,
    "initialPointer": {
      "x": 954,
      "y": 613
    },
    "events": [
      {
        "at": 18.141,
        "x": 1470,
        "y": 930,
        "type": "click",
        "actionId": "135-add-server-settled",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.45,
        "rect": [
          1420,
          910,
          105,
          40
        ]
      },
      {
        "start": 11.1,
        "end": 17,
        "rect": [
          1138,
          379,
          295,
          71
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          1420,
          910,
          105,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 6.141,
        "focus": [
          1420,
          910,
          105,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 7.141
      },
      {
        "at": 11.1
      },
      {
        "at": 12.3,
        "focus": [
          1138,
          379,
          295,
          71
        ],
        "zoom": 2.6
      },
      {
        "at": 17,
        "focus": [
          1138,
          379,
          295,
          71
        ],
        "zoom": 2.6
      },
      {
        "at": 18
      },
      {
        "at": 21
      }
    ]
  },
  {
    "id": "why-agent",
    "chapter": "create-agent",
    "type": "narration",
    "duration": 9,
    "title": "Create a reusable Website Builder",
    "text": "Save instructions it can use for each new website brief."
  },
  {
    "id": "open-agents",
    "chapter": "create-agent",
    "type": "footage",
    "source": "agent-create",
    "sourceStart": 0,
    "sourceEnd": 8,
    "duration": 12,
    "holdLead": 4,
    "holdTail": 0,
    "stillTime": 7.5,
    "initialPointer": {
      "x": 160,
      "y": 180
    },
    "events": [
      {
        "at": 2.181,
        "x": 563,
        "y": 36,
        "type": "click",
        "actionId": "158-open-agents",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.481,
        "rect": [
          509,
          16,
          94,
          40
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          509,
          16,
          94,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 6.181,
        "focus": [
          509,
          16,
          94,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 7.181
      },
      {
        "at": 12
      }
    ]
  },
  {
    "id": "start-simple-agent",
    "chapter": "create-agent",
    "type": "footage",
    "source": "agent-create",
    "sourceStart": 8,
    "sourceEnd": 16,
    "duration": 12,
    "holdLead": 4,
    "holdTail": 0,
    "stillTime": 15.5,
    "initialPointer": {
      "x": 563,
      "y": 36
    },
    "events": [
      {
        "at": 10.286,
        "x": 1260,
        "y": 131,
        "type": "click",
        "actionId": "160-start-simple-agent",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.586,
        "rect": [
          1195,
          111,
          141,
          40
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          1195,
          111,
          141,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 6.286,
        "focus": [
          1195,
          111,
          141,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 7.286
      },
      {
        "at": 12
      }
    ]
  },
  {
    "id": "choose-manual-agent",
    "chapter": "create-agent",
    "type": "footage",
    "source": "agent-create",
    "sourceStart": 16,
    "sourceEnd": 23,
    "duration": 11,
    "holdLead": 4,
    "holdTail": 0,
    "stillTime": 22.5,
    "initialPointer": {
      "x": 1260,
      "y": 131
    },
    "events": [
      {
        "at": 17.536,
        "x": 660,
        "y": 505,
        "type": "click",
        "actionId": "164-manual-setup-settled",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 5.836,
        "rect": [
          573,
          486,
          172,
          40
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          573,
          486,
          172,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 5.536,
        "focus": [
          573,
          486,
          172,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 6.536
      },
      {
        "at": 11
      }
    ]
  },
  {
    "id": "why-agent-goal",
    "chapter": "create-agent",
    "type": "narration",
    "duration": 10,
    "title": "Describe how it should work",
    "text": "Create the files, start a preview, and check the layout and interactions."
  },
  {
    "id": "paste-agent-goal",
    "chapter": "create-agent",
    "type": "footage",
    "source": "agent-create",
    "sourceStart": 23,
    "sourceEnd": 31,
    "duration": 19,
    "holdLead": 5,
    "holdTail": 6,
    "stillTime": 29.5,
    "highlights": [
      {
        "start": 0.8,
        "end": 5.25,
        "rect": [
          467,
          714,
          534,
          79
        ]
      },
      {
        "start": 5.25,
        "end": 15,
        "rect": [
          467,
          714,
          534,
          148
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          457,
          688,
          554,
          185
        ],
        "zoom": 2.2
      },
      {
        "at": 15,
        "focus": [
          457,
          688,
          554,
          185
        ],
        "zoom": 2.2
      },
      {
        "at": 16
      },
      {
        "at": 19
      }
    ]
  },
  {
    "id": "create-agent-step",
    "chapter": "create-agent",
    "type": "footage",
    "source": "agent-create",
    "sourceStart": 31,
    "sourceEnd": 35,
    "duration": 12,
    "holdLead": 4,
    "holdTail": 4,
    "stillTime": 34.5,
    "initialPointer": {
      "x": 688,
      "y": 751
    },
    "events": [
      {
        "at": 32.962,
        "x": 1089,
        "y": 754,
        "type": "click",
        "actionId": "168-create-website-goal-step",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.262,
        "rect": [
          1009,
          714,
          150,
          148
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          1009,
          714,
          150,
          148
        ],
        "zoom": 2.6
      },
      {
        "at": 5.962,
        "focus": [
          1009,
          714,
          150,
          148
        ],
        "zoom": 2.6
      },
      {
        "at": 6.962
      },
      {
        "at": 12
      }
    ]
  },
  {
    "id": "read-agent-instructions",
    "chapter": "create-agent",
    "type": "footage",
    "source": "agent-create",
    "sourceStart": 35,
    "sourceEnd": 38,
    "duration": 24,
    "holdLead": 0,
    "holdTail": 21,
    "stillTime": 36.5,
    "highlights": [
      {
        "start": 0.8,
        "end": 20,
        "rect": [
          1271,
          418,
          284,
          294
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          1260,
          406,
          307,
          316
        ],
        "zoom": 2.6
      },
      {
        "at": 20,
        "focus": [
          1260,
          406,
          307,
          316
        ],
        "zoom": 2.6
      },
      {
        "at": 21
      },
      {
        "at": 24
      }
    ]
  },
  {
    "id": "why-agent-model",
    "chapter": "bind-agent",
    "type": "narration",
    "duration": 8,
    "title": "Use the AI you connected",
    "text": "Website Builder AI will carry out these instructions."
  },
  {
    "id": "open-agent-models",
    "chapter": "bind-agent",
    "type": "footage",
    "source": "agent-bindings",
    "sourceStart": 0,
    "sourceEnd": 7,
    "duration": 11,
    "holdLead": 4,
    "holdTail": 0,
    "stillTime": 6.5,
    "initialPointer": {
      "x": 1089,
      "y": 754
    },
    "events": [
      {
        "at": 2.425,
        "x": 1529,
        "y": 834,
        "type": "click",
        "actionId": "170-choose-agent-model",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.725,
        "rect": [
          1271,
          813,
          284,
          75
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          1271,
          813,
          284,
          75
        ],
        "zoom": 2.6
      },
      {
        "at": 6.425,
        "focus": [
          1271,
          813,
          284,
          75
        ],
        "zoom": 2.6
      },
      {
        "at": 7.425
      },
      {
        "at": 11
      }
    ]
  },
  {
    "id": "select-agent-model",
    "chapter": "bind-agent",
    "type": "footage",
    "source": "agent-bindings",
    "sourceStart": 7,
    "sourceEnd": 14,
    "duration": 11,
    "holdLead": 4,
    "holdTail": 0,
    "stillTime": 13.5,
    "initialPointer": {
      "x": 1529,
      "y": 834
    },
    "events": [
      {
        "at": 9.213,
        "x": 510,
        "y": 522,
        "type": "click",
        "actionId": "172-select-website-builder-ai",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.513,
        "rect": [
          375,
          486,
          273,
          75
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          375,
          486,
          273,
          75
        ],
        "zoom": 2.6
      },
      {
        "at": 6.213,
        "focus": [
          375,
          486,
          273,
          75
        ],
        "zoom": 2.6
      },
      {
        "at": 7.213
      },
      {
        "at": 11
      }
    ]
  },
  {
    "id": "why-agent-tool",
    "chapter": "bind-agent",
    "type": "narration",
    "duration": 9,
    "title": "Give it the tool you prepared",
    "text": "Desktop Commander lets it create files and run the website."
  },
  {
    "id": "open-agent-apps",
    "chapter": "bind-agent",
    "type": "footage",
    "source": "agent-bindings",
    "sourceStart": 14,
    "sourceEnd": 21,
    "duration": 11,
    "holdLead": 4,
    "holdTail": 0,
    "stillTime": 20.5,
    "initialPointer": {
      "x": 510,
      "y": 522
    },
    "events": [
      {
        "at": 15.92,
        "x": 1528,
        "y": 922,
        "type": "click",
        "actionId": "174-add-agent-app",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.22,
        "rect": [
          1271,
          911,
          284,
          65
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          1271,
          911,
          284,
          65
        ],
        "zoom": 2.6
      },
      {
        "at": 5.92,
        "focus": [
          1271,
          911,
          284,
          65
        ],
        "zoom": 2.6
      },
      {
        "at": 6.92
      },
      {
        "at": 11
      }
    ]
  },
  {
    "id": "attach-agent-tool",
    "chapter": "bind-agent",
    "type": "footage",
    "source": "agent-bindings",
    "sourceStart": 21,
    "sourceEnd": 27.9,
    "duration": 22,
    "holdLead": 4,
    "holdTail": 11.1,
    "stillTime": 27.4,
    "initialPointer": {
      "x": 1528,
      "y": 922
    },
    "events": [
      {
        "at": 23.398,
        "x": 1088,
        "y": 477,
        "type": "click",
        "actionId": "176-attach-desktop-commander",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.698,
        "rect": [
          952,
          441,
          273,
          74
        ]
      },
      {
        "start": 10.5,
        "end": 18,
        "rect": [
          1271,
          813,
          284,
          175
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          952,
          441,
          273,
          74
        ],
        "zoom": 2.6
      },
      {
        "at": 6.398,
        "focus": [
          952,
          441,
          273,
          74
        ],
        "zoom": 2.6
      },
      {
        "at": 7.398
      },
      {
        "at": 10.5
      },
      {
        "at": 11.7,
        "focus": [
          1258,
          810,
          309,
          181
        ],
        "zoom": 2.6
      },
      {
        "at": 18,
        "focus": [
          1258,
          810,
          309,
          181
        ],
        "zoom": 2.6
      },
      {
        "at": 19
      },
      {
        "at": 22
      }
    ]
  },
  {
    "id": "why-agent-save",
    "chapter": "save-agent",
    "type": "narration",
    "duration": 9,
    "title": "Save your Website Builder",
    "text": "Give it a name you will recognize when starting a chat."
  },
  {
    "id": "name-website-builder",
    "chapter": "save-agent",
    "type": "footage",
    "source": "agent-save",
    "sourceStart": 0,
    "sourceEnd": 8,
    "duration": 17,
    "holdLead": 4,
    "holdTail": 5,
    "stillTime": 7,
    "highlights": [
      {
        "start": 0.8,
        "end": 13,
        "rect": [
          467,
          762,
          692,
          42
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          457,
          714,
          712,
          110
        ],
        "zoom": 2.1
      },
      {
        "at": 13,
        "focus": [
          457,
          714,
          712,
          110
        ],
        "zoom": 2.1
      },
      {
        "at": 14
      },
      {
        "at": 17
      }
    ]
  },
  {
    "id": "save-website-builder",
    "chapter": "save-agent",
    "type": "footage",
    "source": "agent-save",
    "sourceStart": 8,
    "sourceEnd": 18.9,
    "duration": 25,
    "holdLead": 4,
    "holdTail": 10.1,
    "stillTime": 18.4,
    "initialPointer": {
      "x": 738,
      "y": 783
    },
    "events": [
      {
        "at": 10.636,
        "x": 1423,
        "y": 162,
        "type": "click",
        "actionId": "183-save-website-builder",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.936,
        "rect": [
          1379,
          142,
          92,
          40
        ]
      },
      {
        "start": 14.3,
        "end": 21,
        "rect": [
          1175,
          147,
          72,
          30
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          1379,
          142,
          92,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 6.636,
        "focus": [
          1379,
          142,
          92,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 7.636
      },
      {
        "at": 14.3
      },
      {
        "at": 15.5,
        "focus": [
          1100,
          132,
          330,
          70
        ],
        "zoom": 2.6
      },
      {
        "at": 21,
        "focus": [
          1100,
          132,
          330,
          70
        ],
        "zoom": 2.6
      },
      {
        "at": 22
      },
      {
        "at": 25
      }
    ]
  },
  {
    "id": "why-expert-view",
    "chapter": "save-agent",
    "type": "narration",
    "duration": 8,
    "title": "See the same agent another way",
    "text": "Expert view shows how its task and tool connect."
  },
  {
    "id": "inspect-expert-agent",
    "chapter": "save-agent",
    "type": "footage",
    "source": "agent-save",
    "sourceStart": 19,
    "sourceEnd": 27.9,
    "duration": 22,
    "holdLead": 4,
    "holdTail": 9.1,
    "stillTime": 27.4,
    "initialPointer": {
      "x": 1423,
      "y": 162
    },
    "events": [
      {
        "at": 21.376,
        "x": 1315,
        "y": 162,
        "type": "click",
        "actionId": "185-show-expert-view",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.676,
        "rect": [
          1258,
          147,
          70,
          30
        ]
      },
      {
        "start": 10.5,
        "end": 18,
        "rect": [
          288,
          543,
          932,
          289
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          1258,
          147,
          70,
          30
        ],
        "zoom": 2.6
      },
      {
        "at": 6.376,
        "focus": [
          1258,
          147,
          70,
          30
        ],
        "zoom": 2.6
      },
      {
        "at": 7.376
      },
      {
        "at": 10.5
      },
      {
        "at": 11.7,
        "focus": [
          288,
          543,
          932,
          289
        ],
        "zoom": 1.6
      },
      {
        "at": 18,
        "focus": [
          288,
          543,
          932,
          289
        ],
        "zoom": 1.6
      },
      {
        "at": 19
      },
      {
        "at": 22
      }
    ]
  },
  {
    "id": "return-easy-agent",
    "chapter": "save-agent",
    "type": "footage",
    "source": "agent-save",
    "sourceStart": 28,
    "sourceEnd": 35,
    "duration": 11,
    "holdLead": 4,
    "holdTail": 0,
    "stillTime": 34.5,
    "initialPointer": {
      "x": 1315,
      "y": 162
    },
    "events": [
      {
        "at": 29.734,
        "x": 628,
        "y": 162,
        "type": "click",
        "actionId": "189-return-easy-view",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.034,
        "rect": [
          614,
          147,
          83,
          30
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          614,
          147,
          83,
          30
        ],
        "zoom": 2.6
      },
      {
        "at": 5.734,
        "focus": [
          614,
          147,
          83,
          30
        ],
        "zoom": 2.6
      },
      {
        "at": 6.734
      },
      {
        "at": 11
      }
    ]
  },
  {
    "id": "why-open-chat",
    "chapter": "save-agent",
    "type": "narration",
    "duration": 9,
    "title": "Give it a real brief",
    "text": "Open a chat with Website Builder and describe the website you want."
  },
  {
    "id": "try-website-builder",
    "chapter": "save-agent",
    "type": "footage",
    "source": "agent-save",
    "sourceStart": 35,
    "sourceEnd": 43.9,
    "duration": 21,
    "holdLead": 4,
    "holdTail": 8.1,
    "stillTime": 43.4,
    "initialPointer": {
      "x": 628,
      "y": 162
    },
    "events": [
      {
        "at": 36.86,
        "x": 1481,
        "y": 161,
        "type": "click",
        "actionId": "191-try-website-builder",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.16,
        "rect": [
          1437,
          142,
          89,
          40
        ]
      },
      {
        "start": 11,
        "end": 17,
        "rect": [
          324,
          122,
          145,
          36
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          1437,
          142,
          89,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 5.86,
        "focus": [
          1437,
          142,
          89,
          40
        ],
        "zoom": 2.6
      },
      {
        "at": 6.86
      },
      {
        "at": 11
      },
      {
        "at": 12.2,
        "focus": [
          314,
          72,
          254,
          96
        ],
        "zoom": 2.6
      },
      {
        "at": 17,
        "focus": [
          314,
          72,
          254,
          96
        ],
        "zoom": 2.6
      },
      {
        "at": 18
      },
      {
        "at": 21
      }
    ]
  },
  {
    "id": "why-website-brief",
    "chapter": "build-website",
    "type": "narration",
    "duration": 10,
    "title": "Give it a real website brief",
    "text": "First Pour needs a workshop schedule, three practice stations, and a signup demo."
  },
  {
    "id": "paste-website-brief",
    "chapter": "build-website",
    "type": "footage",
    "source": "website-build",
    "sourceStart": 0,
    "sourceEnd": 7,
    "duration": 15,
    "holdLead": 5,
    "holdTail": 3,
    "stillTime": 5,
    "highlights": [
      {
        "start": 0.8,
        "end": 3,
        "rect": [
          319,
          891,
          1128,
          44
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          319,
          822,
          1128,
          112
        ],
        "zoom": 1.3
      },
      {
        "at": 11,
        "focus": [
          319,
          822,
          1128,
          112
        ],
        "zoom": 1.3
      },
      {
        "at": 12
      },
      {
        "at": 15
      }
    ]
  },
  {
    "id": "send-website-brief",
    "chapter": "build-website",
    "type": "footage",
    "source": "website-build",
    "sourceStart": 7,
    "sourceEnd": 13,
    "duration": 12,
    "holdLead": 4,
    "holdTail": 2,
    "stillTime": 12,
    "initialPointer": {
      "x": 815,
      "y": 912
    },
    "events": [
      {
        "at": 9.697208,
        "x": 1558,
        "y": 913,
        "type": "click",
        "actionId": "send-real-website-brief",
        "travelSeconds": 2
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.997208,
        "rect": [
          1534,
          891,
          45,
          44
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          1534,
          891,
          45,
          44
        ],
        "zoom": 2.6
      },
      {
        "at": 6.697208,
        "focus": [
          1534,
          891,
          45,
          44
        ],
        "zoom": 2.6
      },
      {
        "at": 7.697208
      },
      {
        "at": 12
      }
    ]
  },
  {
    "id": "read-website-brief",
    "chapter": "build-website",
    "type": "footage",
    "source": "website-build",
    "sourceStart": 13,
    "sourceEnd": 22,
    "duration": 18,
    "holdTail": 9,
    "stillTime": 17,
    "highlights": [
      {
        "start": 0.8,
        "end": 14,
        "rect": [
          358,
          219,
          1200,
          147
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          350,
          211,
          1220,
          163
        ],
        "zoom": 1.2
      },
      {
        "at": 14,
        "focus": [
          350,
          211,
          1220,
          163
        ],
        "zoom": 1.2
      },
      {
        "at": 15
      },
      {
        "at": 18
      }
    ]
  },
  {
    "id": "why-website-build",
    "chapter": "build-website",
    "type": "narration",
    "duration": 8,
    "title": "Build the first draft",
    "text": "It creates files and starts the preview.",
    "label": "AI wait shortened"
  },
  {
    "id": "read-website-tool-result",
    "chapter": "build-website",
    "type": "footage",
    "source": "website-build",
    "sourceStart": 22,
    "sourceEnd": 33.9,
    "duration": 19,
    "holdTail": 7.1,
    "stillTime": 30,
    "highlights": [
      {
        "start": 0.8,
        "end": 15,
        "rect": [
          355,
          479,
          397,
          70
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          345,
          463,
          422,
          101
        ],
        "zoom": 2.6
      },
      {
        "at": 15,
        "focus": [
          345,
          463,
          422,
          101
        ],
        "zoom": 2.6
      },
      {
        "at": 16
      },
      {
        "at": 19
      }
    ]
  },
  {
    "id": "why-view-first-draft",
    "chapter": "revise-website",
    "type": "narration",
    "duration": 6,
    "title": "See the first draft",
    "text": "The workshop page is ready to review."
  },
  {
    "id": "view-first-draft-hero",
    "chapter": "revise-website",
    "type": "footage",
    "source": "website-first-hero",
    "duration": 8
  },
  {
    "id": "inspect-first-draft-signup",
    "chapter": "revise-website",
    "type": "footage",
    "source": "website-first-signup",
    "duration": 12,
    "highlights": [
      {
        "start": 0.8,
        "end": 8,
        "rect": [
          417,
          470,
          754,
          510
        ]
      }
    ],
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          417,
          470,
          754,
          510
        ],
        "zoom": 1.8
      },
      {
        "at": 8,
        "focus": [
          417,
          470,
          754,
          510
        ],
        "zoom": 1.8
      },
      {
        "at": 9
      },
      {
        "at": 12
      }
    ]
  },
  {
    "id": "why-revise-website",
    "chapter": "revise-website",
    "type": "narration",
    "duration": 9,
    "title": "Review the first draft",
    "text": "Return to this chat. Add field labels and correct the footer year."
  },
  {
    "id": "paste-website-revision",
    "chapter": "revise-website",
    "type": "footage",
    "source": "website-revision",
    "sourceStart": 0,
    "sourceEnd": 7.5,
    "duration": 15,
    "holdLead": 4,
    "holdTail": 3.5,
    "stillTime": 6,
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          315,
          824,
          1128,
          116
        ],
        "zoom": 1.3
      },
      {
        "at": 11,
        "focus": [
          315,
          824,
          1128,
          116
        ],
        "zoom": 1.3
      },
      {
        "at": 12
      },
      {
        "at": 15
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 11,
        "rect": [
          319,
          840,
          1128,
          94
        ]
      }
    ]
  },
  {
    "id": "send-website-revision",
    "chapter": "revise-website",
    "type": "footage",
    "source": "website-revision",
    "sourceStart": 7.5,
    "sourceEnd": 15.5,
    "duration": 14,
    "holdLead": 4,
    "holdTail": 2.0,
    "stillTime": 11.5,
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          1534,
          891,
          45,
          44
        ],
        "zoom": 2.6
      },
      {
        "at": 6.559208,
        "focus": [
          1534,
          891,
          45,
          44
        ],
        "zoom": 2.6
      },
      {
        "at": 7.559208
      },
      {
        "at": 14
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.859208,
        "rect": [
          1534,
          891,
          45,
          44
        ]
      }
    ],
    "events": [
      {
        "at": 10.059208,
        "x": 1558,
        "y": 913,
        "type": "click",
        "actionId": "send-website-revision",
        "travelSeconds": 2
      }
    ],
    "initialPointer": {
      "x": 850,
      "y": 914
    }
  },
  {
    "id": "why-check-revision",
    "chapter": "revise-website",
    "type": "narration",
    "duration": 8,
    "title": "Check what changed",
    "text": "Labels appeared. The footer still needed correction.",
    "label": "AI wait shortened"
  },
  {
    "id": "inspect-first-revision",
    "chapter": "revise-website",
    "type": "footage",
    "source": "website-revision",
    "sourceStart": 15.5,
    "sourceEnd": 20.5,
    "duration": 8,
    "holdTail": 3.0,
    "stillTime": 19
  },
  {
    "id": "why-repair-website",
    "chapter": "revise-website",
    "type": "narration",
    "duration": 9,
    "title": "Ask for one more correction",
    "text": "Keep working in the same chat to finish the page."
  },
  {
    "id": "paste-website-repair",
    "chapter": "revise-website",
    "type": "footage",
    "source": "website-revision",
    "sourceStart": 20.5,
    "sourceEnd": 28.5,
    "duration": 15,
    "holdLead": 4,
    "holdTail": 3.0,
    "stillTime": 26,
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          310,
          810,
          1140,
          136
        ],
        "zoom": 1.3
      },
      {
        "at": 11,
        "focus": [
          310,
          810,
          1140,
          136
        ],
        "zoom": 1.3
      },
      {
        "at": 12
      },
      {
        "at": 15
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 11,
        "rect": [
          319,
          821,
          1128,
          113
        ]
      }
    ]
  },
  {
    "id": "send-website-repair",
    "chapter": "revise-website",
    "type": "footage",
    "source": "website-revision",
    "sourceStart": 28.5,
    "sourceEnd": 36.5,
    "duration": 14,
    "holdLead": 4,
    "holdTail": 2.0,
    "stillTime": 32.5,
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          1534,
          891,
          45,
          44
        ],
        "zoom": 2.6
      },
      {
        "at": 6.626207999999998,
        "focus": [
          1534,
          891,
          45,
          44
        ],
        "zoom": 2.6
      },
      {
        "at": 7.626207999999998
      },
      {
        "at": 14
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.926207999999998,
        "rect": [
          1534,
          891,
          45,
          44
        ]
      }
    ],
    "events": [
      {
        "at": 31.126208,
        "x": 1558,
        "y": 913,
        "type": "click",
        "actionId": "send-website-repair",
        "travelSeconds": 2
      }
    ],
    "initialPointer": {
      "x": 850,
      "y": 914
    }
  },
  {
    "id": "why-read-repair",
    "chapter": "revise-website",
    "type": "narration",
    "duration": 8,
    "title": "Review the correction",
    "text": "The builder reports its repair. Now check the page.",
    "label": "AI wait shortened"
  },
  {
    "id": "read-website-repair",
    "chapter": "revise-website",
    "type": "footage",
    "source": "website-revision",
    "sourceStart": 36.5,
    "sourceEnd": 45.5,
    "duration": 22,
    "holdLead": 4,
    "holdTail": 9.0,
    "stillTime": 43,
    "camera": [
      {
        "at": 0
      },
      {
        "at": 8.2
      },
      {
        "at": 9.4,
        "focus": [
          354,
          250,
          500,
          104
        ],
        "zoom": 2.6
      },
      {
        "at": 18,
        "focus": [
          354,
          250,
          500,
          104
        ],
        "zoom": 2.6
      },
      {
        "at": 19
      },
      {
        "at": 22
      }
    ],
    "highlights": [
      {
        "start": 8.2,
        "end": 18,
        "rect": [
          354,
          250,
          500,
          104
        ]
      }
    ]
  },
  {
    "id": "why-open-preview",
    "chapter": "revise-website",
    "type": "narration",
    "duration": 8,
    "title": "Open the updated website",
    "text": "Follow the preview link to see First Pour."
  },
  {
    "id": "open-corrected-preview",
    "chapter": "revise-website",
    "type": "footage",
    "source": "website-revision",
    "sourceStart": 45.5,
    "sourceEnd": 49.25,
    "duration": 16,
    "holdLead": 4,
    "holdTail": 8.25,
    "stillTime": 47.375,
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          526,
          701,
          164,
          22
        ],
        "zoom": 2.6
      },
      {
        "at": 6.692208000000001,
        "focus": [
          526,
          701,
          164,
          22
        ],
        "zoom": 2.6
      },
      {
        "at": 7.692208000000001
      },
      {
        "at": 16
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 6.992208000000001,
        "rect": [
          526,
          701,
          164,
          22
        ]
      }
    ],
    "events": [
      {
        "at": 48.192208,
        "x": 607,
        "y": 711,
        "type": "click",
        "actionId": "open-corrected-preview",
        "travelSeconds": 2
      }
    ],
    "initialPointer": {
      "x": 1558,
      "y": 913
    }
  },
  {
    "id": "inspect-corrected-website",
    "chapter": "revise-website",
    "type": "footage",
    "source": "website-revision",
    "sourceStart": 49.25,
    "sourceEnd": 55.4,
    "duration": 17,
    "holdLead": 3,
    "holdTail": 7.85,
    "stillTime": 54,
    "camera": [
      {
        "at": 0
      },
      {
        "at": 8
      },
      {
        "at": 9.2,
        "focus": [
          434,
          408,
          721,
          512
        ],
        "zoom": 1.65
      },
      {
        "at": 13,
        "focus": [
          434,
          408,
          721,
          512
        ],
        "zoom": 1.65
      },
      {
        "at": 14
      },
      {
        "at": 17
      }
    ]
  },
  {
    "id": "why-check-desktop",
    "chapter": "check-website",
    "type": "narration",
    "duration": 10,
    "title": "Try the signup yourself",
    "text": "Use demo details, submit, then reload. This demo makes no reservation and sends no email."
  },
  {
    "id": "fill-desktop-demo",
    "chapter": "check-website",
    "type": "footage",
    "source": "site-acceptance",
    "sourceStart": 0,
    "sourceEnd": 5.4,
    "duration": 14,
    "holdLead": 4,
    "holdTail": 4.6,
    "stillTime": 5.2,
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          592,
          556,
          401,
          166
        ],
        "zoom": 2.6
      },
      {
        "at": 10,
        "focus": [
          592,
          556,
          401,
          166
        ],
        "zoom": 2.6
      },
      {
        "at": 11
      },
      {
        "at": 14
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 10,
        "rect": [
          592,
          556,
          401,
          166
        ]
      }
    ]
  },
  {
    "id": "submit-desktop-demo",
    "chapter": "check-website",
    "type": "footage",
    "source": "site-acceptance",
    "sourceStart": 5.4,
    "sourceEnd": 11.3,
    "duration": 21,
    "holdLead": 4,
    "holdTail": 11.1,
    "stillTime": 10,
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          592,
          754,
          401,
          47
        ],
        "zoom": 2.6
      },
      {
        "at": 5.347021,
        "focus": [
          592,
          754,
          401,
          47
        ],
        "zoom": 2.6
      },
      {
        "at": 6.347021
      },
      {
        "at": 9.5
      },
      {
        "at": 10.7,
        "focus": [
          465,
          688,
          656,
          113
        ],
        "zoom": 2.2
      },
      {
        "at": 17,
        "focus": [
          465,
          688,
          656,
          113
        ],
        "zoom": 2.2
      },
      {
        "at": 18
      },
      {
        "at": 21
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 5.647021,
        "rect": [
          592,
          754,
          401,
          47
        ]
      },
      {
        "start": 9.5,
        "end": 17,
        "rect": [
          465,
          688,
          656,
          113
        ]
      }
    ],
    "events": [
      {
        "at": 6.747021,
        "x": 795,
        "y": 777,
        "type": "click",
        "actionId": "258-submit-final-desktop-demo",
        "travelSeconds": 2
      }
    ],
    "initialPointer": {
      "x": 796,
      "y": 701
    }
  },
  {
    "id": "reload-desktop-demo",
    "chapter": "check-website",
    "type": "footage",
    "source": "site-acceptance",
    "sourceStart": 11.4,
    "sourceEnd": 15,
    "duration": 7,
    "holdLead": 3,
    "holdTail": 0.4,
    "stillTime": 14.8
  },
  {
    "id": "why-meetings-overview",
    "chapter": "tour-meetings",
    "type": "narration",
    "duration": 6,
    "title": "Meetings",
    "text": "Experimental: bring agents together around a topic."
  },
  {
    "id": "meetings-overview",
    "chapter": "tour-meetings",
    "type": "footage",
    "source": "feature-tour",
    "sourceStart": 2.5,
    "sourceEnd": 4.95,
    "duration": 12,
    "holdLead": 3,
    "holdTail": 6.55,
    "stillTime": 4.75,
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          155,
          138,
          740,
          91
        ],
        "zoom": 1.8
      },
      {
        "at": 8,
        "focus": [
          155,
          138,
          740,
          91
        ],
        "zoom": 1.8
      },
      {
        "at": 9
      },
      {
        "at": 12
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 8,
        "rect": [
          155,
          138,
          740,
          91
        ]
      }
    ]
  },
  {
    "id": "why-automation-options",
    "chapter": "tour-automations",
    "type": "narration",
    "duration": 6,
    "title": "Automations",
    "text": "Choose a trigger. Keep FLUJO running."
  },
  {
    "id": "automation-options",
    "chapter": "tour-automations",
    "type": "footage",
    "source": "feature-tour",
    "sourceStart": 17,
    "sourceEnd": 20.9,
    "duration": 12,
    "holdLead": 3,
    "holdTail": 5.1,
    "stillTime": 20.7,
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          439,
          363,
          710,
          421
        ],
        "zoom": 1.8
      },
      {
        "at": 8,
        "focus": [
          439,
          363,
          710,
          421
        ],
        "zoom": 1.8
      },
      {
        "at": 9
      },
      {
        "at": 12
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 8,
        "rect": [
          439,
          363,
          710,
          421
        ]
      }
    ]
  },
  {
    "id": "why-persona-desk",
    "chapter": "tour-personas",
    "type": "narration",
    "duration": 6,
    "title": "Personas",
    "text": "Experimental: Maya remembers earlier work."
  },
  {
    "id": "persona-desk",
    "chapter": "tour-personas",
    "type": "footage",
    "source": "feature-tour",
    "sourceStart": 30.2,
    "sourceEnd": 33.9,
    "duration": 12,
    "holdLead": 3,
    "holdTail": 5.3,
    "stillTime": 33.699999999999996,
    "camera": [
      {
        "at": 0
      },
      {
        "at": 3
      },
      {
        "at": 4.2,
        "focus": [
          553,
          722,
          485,
          275
        ],
        "zoom": 2.6
      },
      {
        "at": 8,
        "focus": [
          553,
          722,
          485,
          275
        ],
        "zoom": 2.6
      },
      {
        "at": 9
      },
      {
        "at": 12
      }
    ],
    "highlights": [
      {
        "start": 0.8,
        "end": 8,
        "rect": [
          553,
          722,
          485,
          275
        ]
      }
    ]
  },
  {
    "id": "finish-website",
    "chapter": "finish",
    "type": "narration",
    "duration": 8,
    "title": "Keep building",
    "text": "Reuse Website Builder. Review each real result as you work."
  }
];

let elapsed = 0;
export const SHOTS = Object.freeze(plan.map(shot => {
  const result = Object.freeze({ ...shot, start: elapsed, end: elapsed + shot.duration });
  elapsed = result.end;
  return result;
}));
export const DURATION = elapsed;
const descriptions = {
  'tour-meetings': { title: 'Meetings', text: 'See the experimental Meetings overview. No meeting is created.' },
  'tour-automations': { title: 'Automations', text: 'See six trigger choices. FLUJO must stay running; no trigger is saved or fired.' },
  'tour-personas': { title: 'Personas', text: 'See the existing Maya persona desk. The demonstrated memories and finished work predate this tour.' },
  finish: { title: 'Keep building', text: 'Reuse the saved Website Builder and review each actual result.' },
  'revise-website': { title: 'Revise and open the website', text: 'Request clearer labels, then repair an incomplete first revision in the same chat. Open the actual corrected local preview. The agent’s response is its report; the following browser checks are performed by the operator.' },
  'check-website': { title: 'Try the desktop signup', text: 'Read the final labels, paste fictional demo details, submit and inspect the confirmation. Reload returns an empty form. This local demo creates no reservation and sends no email.' },
  'build-website': { title: 'Give it a real website brief', text: 'Paste and send the First Pour workshop brief in the real Website Builder chat. The recorded agent creates a directory, writes the page and starts a local preview. Its AI wait is shortened; operator browser checks follow later.' },
  'create-agent': { title: 'Create a reusable agent', text: 'Open Agents, start a simple agent and choose manual setup. Paste the real reusable website-building instructions, then create and read the resulting AI step. The text appears at once because the operator uses paste.' },
  'bind-agent': { title: 'Choose its AI and tools', text: 'Attach the previously tested Website Builder AI connection and DesktopCommanderMCP to this same agent step.' },
  'save-agent': { title: 'Save and open Website Builder', text: 'Name and save Website Builder. Inspect the same saved agent in Expert view, return to Easy view, then use Try it to open its chat.' },
  'connect-tool': { title: 'Give it useful tools', text: 'Open Connected Apps, choose the GitHub route and enter the public DesktopCommanderMCP repository URL. Parse it before downloading the tool.' },
  'prepare-tool': { title: 'Prepare the local tool', text: 'Clone the repository, inspect the actual installation and build, then configure node with dist/index.js and --no-onboarding. Download and installation waits are shortened; actions remain at normal speed.' },
  'test-tool': { title: 'Test and save the tool', text: 'Reuse the built repository through the recorded manual configuration after correcting the folder path. The earlier error remains until the genuine final test passes with 26 tools. Add server then creates the sixth saved card, showing DesktopCommanderMCP Connected.' },
  dashboard: { title: 'Start in the workspace', text: 'Add a reusable website assistant to this existing FLUJO workspace. The opening shows the whole application before beginning setup.' },
  'connect-model': { title: 'Configure the connection', text: 'Enter Website Builder AI, choose OpenRouter, privately enter the provider key, enter the Gemini 3 Flash model ID and save. Public typing is genuine recorded UI entry; the private key entry is omitted.' },
  'test-ai': { title: 'Confirm it works', text: 'Run the real connection test. The model answers and successfully uses a FLUJO tool. This is the successful retry after a private credential correction, not a claim that the first attempt passed.' },
  'ai-setup': { title: 'Give the assistant its AI', text: 'Follow the recorded path through AI Setup, Connect AI and the expert option to an empty configuration form. Actions play at normal speed; routine operator pauses are trimmed. The complete form then opens for configuration.' },
};
export const SCENES = Object.freeze([...new Set(SHOTS.map(shot => shot.chapter))].map(id => {
  const shots = SHOTS.filter(shot => shot.chapter === id);
  return Object.freeze({ id, ...descriptions[id], start: shots[0].start, end: shots.at(-1).end });
}));
