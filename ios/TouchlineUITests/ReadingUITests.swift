import XCTest

final class ReadingUITests: XCTestCase {
    func testFailedSignOutOffersReachableRetry() {
        let app = XCUIApplication()
        app.launchArguments = ["--touchline-ui-test", "--touchline-ui-test-signout-retry"]
        app.launch()
        if app.buttons["ToggleSidebar"].waitForExistence(timeout: 2), !app.staticTexts["Soccer → machine learning"].exists { app.buttons["ToggleSidebar"].tap() }
        let backend = app.buttons["Backend and account"]
        XCTAssertTrue(backend.waitForExistence(timeout: 15))
        backend.tap()
        let signOut = app.buttons["sign-out"]
        XCTAssertTrue(signOut.waitForExistence(timeout: 5))
        if !signOut.isHittable { app.swipeUp() }
        signOut.tap()
        let retry = app.buttons["Retry sign-out and cleanup"]
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        XCTAssertTrue(retry.isHittable)
        retry.tap()
        XCTAssertTrue(signOut.waitForNonExistence(timeout: 5))
    }
    func testBundledLibraryLaunchesOfflineAndRelaunches() {
        let app = XCUIApplication()
        app.launchArguments = ["--touchline-ui-test"]
        app.launch()
        if app.buttons["ToggleSidebar"].waitForExistence(timeout: 2), !app.staticTexts["Soccer → machine learning"].exists { app.buttons["ToggleSidebar"].tap() }
        XCTAssertTrue(app.staticTexts["Soccer → machine learning"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["Backend and account"].exists)
        app.terminate()
        app.launch()
        if app.buttons["ToggleSidebar"].waitForExistence(timeout: 2), !app.staticTexts["Soccer → machine learning"].exists { app.buttons["ToggleSidebar"].tap() }
        XCTAssertTrue(app.staticTexts["Soccer → machine learning"].waitForExistence(timeout: 15))
    }
}
