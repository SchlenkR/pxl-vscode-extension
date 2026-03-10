// ---
// app: MyPixogramName
// displayName: Human Readable Name
// appType: ClockFace
// author: Your Name
// description: Brief description of what this pixogram does
// ---

#:package Pxl@0.0.57

using Pxl.Ui.CSharp;

// State variables go here (persist between frames)
var count = 0;

// We always need to return a DrawingContext delegate that contains our drawing code.
// This is what gets called every frame to render the pixogram.
// The name "scene" is just a convention, you can name it whatever you like.
var scene = (DrawingContext ctx) =>
{
    // Drawing code here — runs every frame

    ctx.DrawBackground(Colors.Blue);

    ctx.DrawTextMono4x5(
        $"Count: {count}",
        color: Colors.White,
        x: 10,
        y: 10);
    count++;
};
